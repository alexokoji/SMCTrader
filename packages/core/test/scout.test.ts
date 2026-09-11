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

function stubFetch(byNetwork: Record<string, { data: unknown[]; included: unknown[] }>): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    for (const [network, body] of Object.entries(byNetwork)) {
      if (url.pathname === `/api/v2/networks/${network}/trending_pools`) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
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
