import { describe, expect, it } from "vitest";
import { DexScreenerClient } from "../src/defi/dexscreener.js";

/** Fixture trimmed from a live capture of the search and single-pair endpoints. */
const SEARCH_FIXTURE = {
  schemaVersion: "1.0.0",
  pairs: [
    {
      chainId: "solana",
      dexId: "raydium",
      pairAddress: "FCEnSxyJfRSKsz6tASUENCsfGwKgkH6YuRn1AMmyHhZn",
      url: "https://dexscreener.com/solana/fcensxyjfrsksz6tasuencsfgwkgkh6yurn1ammyhhzn",
      baseToken: { address: "B5WTLaRwaUQpKk7ir1wniNB6m5o8GgMrimhKMYan2R6B", name: "Pepe", symbol: "Pepe" },
      quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
      priceUsd: "0.0006581",
      volume: { h24: 593305.85 },
      priceChange: { h24: 24.65 },
      liquidity: { usd: 231555.71 },
      fdv: 657843,
      pairCreatedAt: 1716658709000,
    },
  ],
};

const SINGLE_PAIR_FIXTURE = {
  schemaVersion: "1.0.0",
  pairs: [
    {
      chainId: "ethereum",
      dexId: "uniswap",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      url: "https://dexscreener.com/ethereum/0xa43fe16908251ee70ef74718545e4fe6c5ccec9f",
      baseToken: { address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", name: "Pepe", symbol: "PEPE" },
      quoteToken: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", name: "Wrapped Ether", symbol: "WETH" },
      priceUsd: "0.000003284",
      volume: { h24: 1015520.08 },
      priceChange: { h24: -8.94 },
      liquidity: { usd: 26209710.29 },
    },
  ],
};

function stubFetch(byPath: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    for (const [path, body] of Object.entries(byPath)) {
      if (url.pathname.startsWith(path)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ pairs: null }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("DexScreenerClient", () => {
  it("parses a search result against the real response shape", async () => {
    const client = new DexScreenerClient({ fetchFn: stubFetch({ "/latest/dex/search": SEARCH_FIXTURE }) });
    const [pair] = await client.search("PEPE");

    expect(pair).toBeDefined();
    expect(pair!.chainId).toBe("solana");
    expect(pair!.dexId).toBe("raydium");
    expect(pair!.priceUsd).toBeCloseTo(0.0006581, 8);
    expect(pair!.liquidityUsd).toBeCloseTo(231555.71, 2);
    expect(pair!.fdvUsd).toBe(657843);
    expect(pair!.priceChangePct24h).toBeCloseTo(24.65, 2);
  });

  it("returns an empty list rather than throwing when nothing matches", async () => {
    const client = new DexScreenerClient({ fetchFn: stubFetch({}) });
    expect(await client.search("NOTATHING")).toEqual([]);
  });

  it("fetches a single pair by chain and address", async () => {
    const client = new DexScreenerClient({
      fetchFn: stubFetch({ "/latest/dex/pairs/ethereum": SINGLE_PAIR_FIXTURE }),
    });
    const pair = await client.getPair("ethereum", "0xa43fe16908251ee70ef74718545e4fe6c5ccec9f");
    expect(pair?.baseToken.symbol).toBe("PEPE");
    expect(pair?.chainId).toBe("ethereum");
  });

  it("returns null for a pair DexScreener has never indexed", async () => {
    const client = new DexScreenerClient({ fetchFn: stubFetch({}) });
    expect(await client.getPair("ethereum", "0xdeadbeef")).toBeNull();
  });
});
