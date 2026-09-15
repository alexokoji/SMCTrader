import { describe, expect, it } from "vitest";
import { CoinGeckoClient } from "../src/marketdata/coingecko.js";

/** Fixture trimmed from a live capture of /coins/markets. */
function row(overrides: Partial<{
  symbol: string;
  marketCap: number;
  volume: number;
  changePct: number;
  price: number;
  rank: number;
}> = {}) {
  return {
    symbol: overrides.symbol ?? "btc",
    market_cap: overrides.marketCap ?? 1_552_086_563_504,
    total_volume: overrides.volume ?? 14_587_751_895,
    price_change_percentage_24h: overrides.changePct ?? 0.07945,
    current_price: overrides.price ?? 77_282,
    market_cap_rank: overrides.rank ?? 1,
  };
}

function stubFetch(pages: ReturnType<typeof row>[][]): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? "1");
    return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("CoinGeckoClient", () => {
  it("parses a market row against the real response shape", async () => {
    const client = new CoinGeckoClient({ fetchFn: stubFetch([[row()]]) });
    const [btc] = await client.markets({ pages: 1 });
    expect(btc).toEqual({
      symbol: "BTC",
      marketCapUsd: 1_552_086_563_504,
      volumeUsd24h: 14_587_751_895,
      priceChangePct24h: 0.07945,
      priceUsd: 77_282,
      marketCapRank: 1,
    });
  });

  it("fetches multiple pages and merges them", async () => {
    const client = new CoinGeckoClient({
      fetchFn: stubFetch([[row({ symbol: "btc", rank: 1 })], [row({ symbol: "eth", rank: 2 })]]),
    });
    const markets = await client.markets({ pages: 2, perPage: 1 });
    expect(markets.map((m) => m.symbol).sort()).toEqual(["BTC", "ETH"]);
  });

  it("stops paging once a short page signals the end of the list", async () => {
    let calls = 0;
    const client = new CoinGeckoClient({
      fetchFn: (async (input: string | URL) => {
        calls++;
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("page"));
        return new Response(JSON.stringify(page === 1 ? [row()] : []), { status: 200 }); // page 1 short (1 of a possible 250)
      }) as unknown as typeof fetch,
    });
    await client.markets({ pages: 5, perPage: 250 });
    expect(calls).toBe(1);
  });

  it("keeps the higher-ranked coin when two share a ticker", async () => {
    const client = new CoinGeckoClient({
      fetchFn: stubFetch([[
        row({ symbol: "sol", rank: 900, marketCap: 1_000_000 }),
        row({ symbol: "sol", rank: 6, marketCap: 90_000_000_000 }),
      ]]),
    });
    const [sol] = await client.markets({ pages: 1 });
    expect(sol!.marketCapRank).toBe(6);
    expect(sol!.marketCapUsd).toBe(90_000_000_000);
  });

  it("drops a row missing the fields this needs, rather than fabricating them", async () => {
    const client = new CoinGeckoClient({
      fetchFn: stubFetch([[{ symbol: "ghost", market_cap: null, total_volume: null, current_price: null, price_change_percentage_24h: null, market_cap_rank: null } as never]]),
    });
    expect(await client.markets({ pages: 1 })).toEqual([]);
  });

  it("throws with the response status on an API error", async () => {
    const client = new CoinGeckoClient({
      fetchFn: (async () => new Response("", { status: 429 })) as unknown as typeof fetch,
    });
    await expect(client.markets()).rejects.toThrow(/429/);
  });

  it("starts pagination at startPage rather than page 1", async () => {
    const requestedPages: number[] = [];
    const client = new CoinGeckoClient({
      fetchFn: (async (input: string | URL) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        requestedPages.push(page);
        return new Response(JSON.stringify([row({ rank: page })]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.markets({ startPage: 5, pages: 2, perPage: 1 });
    expect(requestedPages).toEqual([5, 6]);
  });

  it("stops paginating once a page's lowest cap drops below stopBelowMarketCapUsd", async () => {
    const requestedPages: number[] = [];
    const client = new CoinGeckoClient({
      fetchFn: (async (input: string | URL) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        requestedPages.push(page);
        // Cap falls by page: page 5 -> $10M, page 6 -> $5M, page 7 -> $1M (below floor)
        const cap = page === 5 ? 10_000_000 : page === 6 ? 5_000_000 : 1_000_000;
        return new Response(JSON.stringify([row({ symbol: `tok${page}`, marketCap: cap, rank: page })]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const markets = await client.markets({ startPage: 5, pages: 10, perPage: 1, stopBelowMarketCapUsd: 2_000_000 });
    // Page 7 (below the floor) is still included — its data is real and
    // useful, this only stops *further* pagination, not that page's rows.
    expect(requestedPages).toEqual([5, 6, 7]);
    expect(markets.map((m) => m.symbol)).toEqual(["TOK5", "TOK6", "TOK7"]);
  });

  describe("rate-limit resilience", () => {
    // A live back-to-back multi-page fetch 429'd on the very next attempt
    // within the same minute — CoinGecko's free tier is this tight in
    // practice, not just in theory, so these are not a hypothetical edge case.

    it("retries once after a short wait on a 429, then succeeds", async () => {
      let attempts = 0;
      const client = new CoinGeckoClient({
        fetchFn: (async () => {
          attempts++;
          if (attempts === 1) return new Response("", { status: 429 });
          return new Response(JSON.stringify([row()]), { status: 200 });
        }) as unknown as typeof fetch,
      });
      const markets = await client.markets({ pages: 1 });
      expect(attempts).toBe(2);
      expect(markets).toHaveLength(1);
    });

    it("keeps earlier pages rather than discarding everything when a later page 429s twice", async () => {
      let calls = 0;
      const client = new CoinGeckoClient({
        fetchFn: (async (input: string | URL) => {
          const page = Number(new URL(String(input)).searchParams.get("page"));
          calls++;
          if (page === 1) return new Response(JSON.stringify([row({ symbol: "btc" })]), { status: 200 });
          return new Response("", { status: 429 }); // page 2 fails even after the internal retry
        }) as unknown as typeof fetch,
      });
      const markets = await client.markets({ pages: 3, perPage: 1 });
      expect(markets.map((m) => m.symbol)).toEqual(["BTC"]);
      // page 1 (1 call) + page 2 (1 call + 1 retry) = 3, then stops rather
      // than attempting page 3 at all.
      expect(calls).toBe(3);
    });

    it("still throws when the very first page fails — there is nothing to fall back to", async () => {
      const client = new CoinGeckoClient({
        fetchFn: (async () => new Response("", { status: 429 })) as unknown as typeof fetch,
      });
      await expect(client.markets({ pages: 3 })).rejects.toThrow(/429/);
    });
  });
});
