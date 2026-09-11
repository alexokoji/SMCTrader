import { describe, expect, it } from "vitest";
import { GeckoTerminalClient } from "../src/defi/geckoterminal.js";

/**
 * Fixtures below are trimmed captures of the live API response, not invented
 * shapes — a parser tested against a guessed shape can pass while silently
 * reading the wrong field from the real one.
 */

const SEARCH_FIXTURE = {
  data: [
    {
      id: "eth_0xa43fe16908251ee70ef74718545e4fe6c5ccec9f",
      type: "pool",
      attributes: {
        base_token_price_usd: "0.00000329493925423147",
        address: "0xa43fe16908251ee70ef74718545e4fe6c5ccec9f",
        name: "PEPE / WETH",
        pool_created_at: "2023-04-14T17:21:11Z",
        fdv_usd: "1355116308.86879",
        market_cap_usd: "1377771793.93401",
        price_change_percentage: { m5: "0", m15: "-0.436", h1: "-0.125", h6: "-4.119", h24: "-9.007" },
        volume_usd: { h24: "1016031.01557847" },
        reserve_in_usd: "26211262.3727",
      },
      relationships: {
        base_token: { data: { id: "eth_0x6982508145454ce325ddbe47a25d4ec3d2311933", type: "token" } },
        quote_token: { data: { id: "eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", type: "token" } },
        dex: { data: { id: "uniswap_v2", type: "dex" } },
      },
    },
  ],
  included: [
    {
      id: "eth_0x6982508145454ce325ddbe47a25d4ec3d2311933",
      type: "token",
      attributes: { address: "0x6982508145454ce325ddbe47a25d4ec3d2311933", name: "Pepe", symbol: "PEPE", decimals: 18 },
    },
    {
      id: "eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      type: "token",
      attributes: { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    },
    { id: "uniswap_v2", type: "dex", attributes: { name: "Uniswap V2" } },
  ],
};

const OHLCV_FIXTURE = {
  data: {
    id: "378b12ed-0b4a-40dc-a2c9-32e3fa0a9ab0",
    type: "ohlcv_request_response",
    attributes: {
      ohlcv_list: [
        [1789063200, 3.29424430650403e-6, 3.30242868216784e-6, 3.27502862947009e-6, 3.27518571203317e-6, 7706.665470152857],
        [1789059600, 3.25931608525376e-6, 3.31573867764671e-6, 3.25716616810344e-6, 3.29424430650403e-6, 47678.45655880085],
      ],
    },
  },
  meta: {
    base: { name: "Pepe", symbol: "PEPE", coingecko_coin_id: "pepe", address: "0x6982508145454ce325ddbe47a25d4ec3d2311933" },
    quote: { name: "Wrapped Ether", symbol: "WETH", coingecko_coin_id: "weth", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
  },
};

function stubFetch(byPath: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    for (const [path, body] of Object.entries(byPath)) {
      if (url.pathname.startsWith(path)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("GeckoTerminalClient", () => {
  it("parses a pool search result against the real response shape", async () => {
    const client = new GeckoTerminalClient({ fetchFn: stubFetch({ "/api/v2/search/pools": SEARCH_FIXTURE }) });
    const [pool] = await client.searchPools("PEPE", "eth");

    expect(pool).toBeDefined();
    expect(pool!.network).toBe("eth");
    expect(pool!.dex).toBe("uniswap_v2");
    expect(pool!.baseToken).toEqual({ address: "0x6982508145454ce325ddbe47a25d4ec3d2311933", symbol: "PEPE", name: "Pepe", decimals: 18 });
    expect(pool!.quoteToken.symbol).toBe("WETH");
    expect(pool!.priceUsd).toBeCloseTo(0.00000329493925423147, 15);
    expect(pool!.liquidityUsd).toBeCloseTo(26211262.3727, 2);
    expect(pool!.volumeUsd24h).toBeCloseTo(1016031.01557847, 2);
    expect(pool!.priceChangePct.h24).toBeCloseTo(-9.007, 3);
  });

  it("drops a pool if its token relationships cannot be resolved, rather than fabricating one", async () => {
    const broken = { ...SEARCH_FIXTURE, included: [] };
    const client = new GeckoTerminalClient({ fetchFn: stubFetch({ "/api/v2/search/pools": broken }) });
    expect(await client.searchPools("PEPE", "eth")).toEqual([]);
  });

  it("converts OHLCV candles to the shared Candle shape, in milliseconds", async () => {
    const client = new GeckoTerminalClient({
      fetchFn: stubFetch({ "/api/v2/networks/eth/pools/0xpool/ohlcv/hour": OHLCV_FIXTURE }),
    });
    const candles = await client.getOHLCV("eth", "0xpool", "1H", 10);

    expect(candles).toHaveLength(2);
    // Oldest first: the API returns newest-first.
    expect(candles[0]!.timestamp).toBe(1789059600 * 1000);
    expect(candles[1]!.timestamp).toBe(1789063200 * 1000);
    expect(candles[0]!.close).toBeCloseTo(3.29424430650403e-6, 15);
    expect(candles[0]!.timeframe).toBe("1H");
    expect(candles[0]!.symbol).toBe("0xpool");
  });

  it("throws with the response status when the API returns an error", async () => {
    const client = new GeckoTerminalClient({
      fetchFn: (async () => new Response("", { status: 429 })) as unknown as typeof fetch,
    });
    await expect(client.searchPools("PEPE")).rejects.toThrow(/429/);
  });
});
