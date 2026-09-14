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
});
