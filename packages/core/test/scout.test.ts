import { describe, expect, it } from "vitest";
import { Scout, DEFAULT_SCOUT_FILTERS } from "../src/defi/scout.js";
import { CHAINS } from "../src/defi/chains.js";

/**
 * The filters here exist to reject exactly the kind of pool a rug pull looks
 * like before it collapses: thin liquidity, no real volume, minutes old, or
 * priced against a token with no reliable USD path. Every filter test below
 * constructs a pool that fails exactly one of them and confirms it is
 * dropped — a scout that discovers a token is worth nothing if it also
 * discovers the honeypot next to it.
 */

const NOW = Date.parse("2026-06-01T00:00:00Z");
const eth = CHAINS.ethereum;

function pool(overrides: Partial<{
  address: string;
  liquidity: number;
  volume: number;
  ageMs: number;
  h1Change: number;
  quoteAddress: string;
  baseSymbol: string;
}> = {}) {
  const age = overrides.ageMs ?? 30 * 24 * 60 * 60 * 1000;
  return {
    id: `eth_${overrides.address ?? "0xpool1"}`,
    type: "pool",
    attributes: {
      address: overrides.address ?? "0xpool1",
      name: `${overrides.baseSymbol ?? "TOKEN"} / WETH`,
      base_token_price_usd: "1.23",
      fdv_usd: "5000000",
      market_cap_usd: "5000000",
      price_change_percentage: { h1: String(overrides.h1Change ?? 2), h24: String(overrides.h1Change ?? 2) },
      volume_usd: { h24: String(overrides.volume ?? 200_000) },
      reserve_in_usd: String(overrides.liquidity ?? 200_000),
      pool_created_at: new Date(NOW - age).toISOString(),
    },
    relationships: {
      base_token: { data: { id: "eth_base", type: "token" } },
      quote_token: { data: { id: "eth_quote", type: "token" } },
      dex: { data: { id: "uniswap_v2", type: "dex" } },
    },
  };
}

function included(quoteAddress: string, baseSymbol = "TOKEN") {
  return [
    { id: "eth_base", type: "token", attributes: { address: "0xbase", symbol: baseSymbol, name: baseSymbol, decimals: 18 } },
    { id: "eth_quote", type: "token", attributes: { address: quoteAddress, symbol: "WETH", name: "Wrapped Ether", decimals: 18 } },
  ];
}

function dexPair(overrides: Partial<{
  chainId: string;
  pairAddress: string;
  baseAddress: string;
  baseSymbol: string;
  quoteAddress: string;
  liquidity: number;
  volume: number;
  changePct24h: number;
  ageMs: number;
}> = {}) {
  const age = overrides.ageMs ?? 30 * 24 * 60 * 60 * 1000;
  return {
    chainId: overrides.chainId ?? "ethereum",
    dexId: "uniswap",
    pairAddress: overrides.pairAddress ?? "0xdexpool1",
    url: "https://dexscreener.com/x",
    baseToken: { address: overrides.baseAddress ?? "0xdexbase", symbol: overrides.baseSymbol ?? "DEXTOKEN", name: "DexToken" },
    quoteToken: { address: overrides.quoteAddress ?? eth.wrappedNativeAddress, symbol: "WETH", name: "Wrapped Ether" },
    priceUsd: "2.5",
    liquidity: { usd: overrides.liquidity ?? 200_000 },
    fdv: 5_000_000,
    volume: { h24: overrides.volume ?? 200_000 },
    priceChange: { h24: overrides.changePct24h ?? 3 },
    pairCreatedAt: NOW - age,
  };
}

/** No DexScreener fixtures by default — an empty address list means neither
 * boosts nor profiles is even called with anything to verify. */
function stubFetch(
  byNetwork: Record<string, { data: unknown[]; included: unknown[] }>,
  dexscreener: {
    boosts?: { chainId: string; tokenAddress: string }[];
    profiles?: { chainId: string; tokenAddress: string }[];
    tokens?: Record<string, unknown[]>; // keyed by "chainId:addr1,addr2"
  } = {},
): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    for (const [network, body] of Object.entries(byNetwork)) {
      if (url.pathname === `/api/v2/networks/${network}/trending_pools`) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    if (url.pathname === "/token-boosts/latest/v1") {
      return new Response(JSON.stringify(dexscreener.boosts ?? []), { status: 200 });
    }
    if (url.pathname === "/token-profiles/latest/v1") {
      return new Response(JSON.stringify(dexscreener.profiles ?? []), { status: 200 });
    }
    if (url.pathname.startsWith("/tokens/v1/")) {
      const [, , , chainId, addrs] = url.pathname.split("/");
      const key = `${chainId}:${addrs}`;
      return new Response(JSON.stringify(dexscreener.tokens?.[key] ?? []), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Scout discovery", () => {
  it("accepts a pool that clears every filter", async () => {
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: { data: [pool({ quoteAddress: eth.wrappedNativeAddress.toLowerCase() })], included: included(eth.wrappedNativeAddress.toLowerCase()) },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.network).toBe("ethereum");
    expect(candidates[0]!.symbol).toBe("ethereum:0xpool1");
  });

  it("rejects a pool below the liquidity floor", async () => {
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: {
          data: [pool({ liquidity: DEFAULT_SCOUT_FILTERS.minLiquidityUsd - 1, quoteAddress: eth.wrappedNativeAddress.toLowerCase() })],
          included: included(eth.wrappedNativeAddress.toLowerCase()),
        },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("rejects a pool with no real volume behind its liquidity", async () => {
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: {
          data: [pool({ volume: DEFAULT_SCOUT_FILTERS.minVolumeUsd24h - 1, quoteAddress: eth.wrappedNativeAddress.toLowerCase() })],
          included: included(eth.wrappedNativeAddress.toLowerCase()),
        },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("rejects a pool younger than the minimum age, the classic rug-pull window", async () => {
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: {
          data: [pool({ ageMs: 60 * 60 * 1000, quoteAddress: eth.wrappedNativeAddress.toLowerCase() })],
          included: included(eth.wrappedNativeAddress.toLowerCase()),
        },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("rejects a pool that moved too far in the last hour to be a stable read", async () => {
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: {
          data: [pool({ h1Change: DEFAULT_SCOUT_FILTERS.maxPriceChangePct1h + 1, quoteAddress: eth.wrappedNativeAddress.toLowerCase() })],
          included: included(eth.wrappedNativeAddress.toLowerCase()),
        },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("rejects a pool quoted against a token with no reliable USD path", async () => {
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: { data: [pool({ quoteAddress: "0xrandomtoken" })], included: included("0xrandomtoken") },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("accepts a pool quoted against the chain's stablecoin as well as its wrapped native", async () => {
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: { data: [pool({ quoteAddress: eth.stableAddress.toLowerCase() })], included: included(eth.stableAddress.toLowerCase()) },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(1);
  });

  it("rejects a pool whose base token is itself a stablecoin, which has no trend to trade", async () => {
    // A live discovery run turned up exactly this: a "USDC" candidate on a
    // USDC/DAI-style pool — high volume, no trend, nothing to analyse.
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: {
          data: [pool({ baseSymbol: "USDC", quoteAddress: eth.stableAddress.toLowerCase() })],
          included: included(eth.stableAddress.toLowerCase(), "USDC"),
        },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("ranks by turnover (volume relative to liquidity), highest first", async () => {
    const scout = new Scout({
      fetchFn: stubFetch({
        eth: {
          data: [
            pool({ address: "0xlow", liquidity: 500_000, volume: 100_000, quoteAddress: eth.wrappedNativeAddress.toLowerCase() }),
            pool({ address: "0xhigh", liquidity: 100_000, volume: 500_000, quoteAddress: eth.wrappedNativeAddress.toLowerCase() }),
          ],
          included: included(eth.wrappedNativeAddress.toLowerCase()),
        },
      }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates.map((c) => c.poolAddress)).toEqual(["0xhigh", "0xlow"]);
  });

  it("continues to other chains when one chain's fetch fails", async () => {
    const scout = new Scout({
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/networks/eth/")) throw new Error("network down");
        if (url.pathname.includes("/networks/bsc/")) {
          return new Response(
            JSON.stringify({
              data: [pool({ address: "0xbsc1", quoteAddress: CHAINS.bsc.wrappedNativeAddress.toLowerCase() })],
              included: included(CHAINS.bsc.wrappedNativeAddress.toLowerCase()),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const { candidates, chainErrors } = await scout.discover({ chains: ["ethereum", "bsc"], now: NOW });
    expect(chainErrors).toEqual([{ chain: "ethereum", reason: "network down" }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.network).toBe("bsc");
  });

  it("caps the number of candidates returned", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      pool({ address: `0xpool${i}`, quoteAddress: eth.wrappedNativeAddress.toLowerCase() }),
    );
    const scout = new Scout({
      fetchFn: stubFetch({ eth: { data: many, included: included(eth.wrappedNativeAddress.toLowerCase()) } }),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW, limit: 5 });
    expect(candidates).toHaveLength(5);
  });
});

describe("DexScreener as a second, independent source", () => {
  it("surfaces a candidate DexScreener found that GeckoTerminal did not, once it clears the same filters", async () => {
    const scout = new Scout({
      fetchFn: stubFetch(
        { eth: { data: [], included: [] } }, // GeckoTerminal finds nothing this tick
        {
          boosts: [{ chainId: "ethereum", tokenAddress: "0xdexbase" }],
          tokens: { "ethereum:0xdexbase": [dexPair()] },
        },
      ),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe("dexscreener");
    expect(candidates[0]!.baseSymbol).toBe("DEXTOKEN");
  });

  it("still applies every safety filter to a DexScreener-sourced lead — being boosted earns nothing", async () => {
    const scout = new Scout({
      fetchFn: stubFetch(
        { eth: { data: [], included: [] } },
        {
          boosts: [{ chainId: "ethereum", tokenAddress: "0xthin" }],
          tokens: {
            "ethereum:0xthin": [dexPair({ baseAddress: "0xthin", liquidity: DEFAULT_SCOUT_FILTERS.minLiquidityUsd - 1 })],
          },
        },
      ),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("drops a lead on a chain outside the registry rather than mis-tagging it", async () => {
    const scout = new Scout({
      fetchFn: stubFetch(
        { eth: { data: [], included: [] } },
        { boosts: [{ chainId: "solana", tokenAddress: "sol123" }] }, // no "solana:sol123" tokens fixture at all
      ),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("dedupes a pool both sources found, keeping the GeckoTerminal entry", async () => {
    const scout = new Scout({
      fetchFn: stubFetch(
        {
          eth: {
            data: [pool({ address: "0xshared", quoteAddress: eth.wrappedNativeAddress.toLowerCase(), liquidity: 999_000 })],
            included: included(eth.wrappedNativeAddress.toLowerCase()),
          },
        },
        {
          boosts: [{ chainId: "ethereum", tokenAddress: "0xbase" }],
          // DexScreener reports the SAME pool address as GeckoTerminal, with a
          // different liquidity figure — the merge must not double-count it.
          tokens: { "ethereum:0xbase": [dexPair({ pairAddress: "0xshared", liquidity: 1 })] },
        },
      ),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe("geckoterminal");
    expect(candidates[0]!.liquidityUsd).toBe(999_000);
  });

  it("reports a DexScreener-wide failure separately from a per-chain GeckoTerminal failure", async () => {
    const scout = new Scout({
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith("/token-boosts") || url.pathname.startsWith("/token-profiles")) {
          throw new Error("dexscreener down");
        }
        return stubFetch({
          eth: { data: [pool({ quoteAddress: eth.wrappedNativeAddress.toLowerCase() })], included: included(eth.wrappedNativeAddress.toLowerCase()) },
        })(input as never);
      }) as unknown as typeof fetch,
    });
    const { candidates, sourceErrors } = await scout.discover({ chains: ["ethereum"], now: NOW });
    // GeckoTerminal's candidate still comes through despite DexScreener failing.
    expect(candidates).toHaveLength(1);
    expect(sourceErrors).toEqual([{ source: "dexscreener", reason: "dexscreener down" }]);
  });

  it("does not filter a DexScreener candidate on hourly price change, which it does not report", async () => {
    // GeckoTerminal candidates are filtered on 1h change; DexScreener's pair
    // shape here carries no such figure, so it must not be penalised for one
    // it was never given.
    const scout = new Scout({
      fetchFn: stubFetch(
        { eth: { data: [], included: [] } },
        {
          boosts: [{ chainId: "ethereum", tokenAddress: "0xbase" }],
          tokens: { "ethereum:0xbase": [dexPair({ changePct24h: 90 })] }, // would fail an hourly filter, if applied
        },
      ),
    });
    const { candidates } = await scout.discover({ chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(1);
  });
});

describe("discoverFromSymbols — resolving news-mentioned tickers", () => {
  function searchStubFetch(bySymbol: Record<string, { data: unknown[]; included: unknown[] }>): typeof fetch {
    return (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/search/pools") {
        const query = url.searchParams.get("query") ?? "";
        const body = bySymbol[query];
        if (body) return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("resolves a news-mentioned symbol to a real pool and tags it as news-sourced", async () => {
    const scout = new Scout({
      fetchFn: searchStubFetch({
        DOGE: {
          data: [pool({ address: "0xdoge1", baseSymbol: "DOGE", quoteAddress: eth.wrappedNativeAddress.toLowerCase() })],
          included: included(eth.wrappedNativeAddress.toLowerCase(), "DOGE"),
        },
      }),
    });
    const candidates = await scout.discoverFromSymbols(["DOGE"], { chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.fromNews).toBe(true);
    expect(candidates[0]!.baseSymbol).toBe("DOGE");
  });

  it("still rejects a news-mentioned symbol whose pool fails the safety filters", async () => {
    const scout = new Scout({
      fetchFn: searchStubFetch({
        SCAM: {
          data: [pool({ address: "0xscam", baseSymbol: "SCAM", liquidity: 1, quoteAddress: eth.wrappedNativeAddress.toLowerCase() })],
          included: included(eth.wrappedNativeAddress.toLowerCase(), "SCAM"),
        },
      }),
    });
    const candidates = await scout.discoverFromSymbols(["SCAM"], { chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("drops a search result on a chain outside the registry", async () => {
    const scout = new Scout({
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/search/pools") {
          return new Response(
            JSON.stringify({
              data: [{
                id: "solana_notreal",
                type: "pool",
                attributes: {
                  address: "notreal", name: "X / SOL", base_token_price_usd: "1", fdv_usd: "1000000",
                  market_cap_usd: "1000000", price_change_percentage: { h1: "1", h24: "1" },
                  volume_usd: { h24: "1000000" }, reserve_in_usd: "1000000",
                  pool_created_at: new Date(NOW - 30 * 24 * 3_600_000).toISOString(),
                },
                relationships: {
                  base_token: { data: { id: "solana_base", type: "token" } },
                  quote_token: { data: { id: "solana_quote", type: "token" } },
                  dex: { data: { id: "raydium", type: "dex" } },
                },
              }],
              included: [
                { id: "solana_base", type: "token", attributes: { address: "base", symbol: "X", name: "X", decimals: 9 } },
                { id: "solana_quote", type: "token", attributes: { address: "quote", symbol: "SOL", name: "SOL", decimals: 9 } },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const candidates = await scout.discoverFromSymbols(["X"], { chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(0);
  });

  it("continues to the next symbol when one search fails", async () => {
    const scout = new Scout({
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/search/pools" && url.searchParams.get("query") === "BROKEN") {
          throw new Error("rate limited");
        }
        return searchStubFetch({
          OK: {
            data: [pool({ address: "0xok", baseSymbol: "OK", quoteAddress: eth.wrappedNativeAddress.toLowerCase() })],
            included: included(eth.wrappedNativeAddress.toLowerCase(), "OK"),
          },
        })(input as never);
      }) as unknown as typeof fetch,
    });
    const candidates = await scout.discoverFromSymbols(["BROKEN", "OK"], { chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.baseSymbol).toBe("OK");
  });

  it("deduplicates when the same pool turns up for more than one symbol search", async () => {
    const fetchFn = searchStubFetch({
      A: { data: [pool({ address: "0xshared", quoteAddress: eth.wrappedNativeAddress.toLowerCase() })], included: included(eth.wrappedNativeAddress.toLowerCase()) },
      B: { data: [pool({ address: "0xshared", quoteAddress: eth.wrappedNativeAddress.toLowerCase() })], included: included(eth.wrappedNativeAddress.toLowerCase()) },
    });
    const scout = new Scout({ fetchFn });
    const candidates = await scout.discoverFromSymbols(["A", "B"], { chains: ["ethereum"], now: NOW });
    expect(candidates).toHaveLength(1);
  });
});
