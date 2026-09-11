import { describe, expect, it } from "vitest";
import { CexScreener, DEFAULT_SCREENER_FILTERS, isTradeableBase } from "../src/marketdata/screener.js";

/**
 * The filters exist to keep "best option for spot trading" from including a
 * pair with too little depth to trade cleanly, one only moving because it is
 * spiking, or a stablecoin against another stablecoin with nothing to trend.
 */

function binanceRow(symbol: string, overrides: Partial<{ price: number; volume: number; changePct: number }> = {}) {
  return {
    symbol,
    lastPrice: String(overrides.price ?? 1),
    quoteVolume: String(overrides.volume ?? 50_000_000),
    priceChangePercent: String(overrides.changePct ?? 2),
  };
}

function stubFetch(rows: ReturnType<typeof binanceRow>[]): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("binance")) return new Response(JSON.stringify(rows), { status: 200 });
    return new Response(JSON.stringify({ result: { list: [] } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("isTradeableBase", () => {
  it("rejects a stablecoin priced against USDT", () => {
    expect(isTradeableBase("USDCUSDT")).toBe(false);
    expect(isTradeableBase("FDUSDUSDT")).toBe(false);
  });

  it("accepts an ordinary asset", () => {
    expect(isTradeableBase("BTCUSDT")).toBe(true);
    expect(isTradeableBase("SOLUSDT")).toBe(true);
  });
});

describe("CexScreener", () => {
  it("ranks by 24h quote volume, highest first", async () => {
    const screener = new CexScreener({
      fetchFn: stubFetch([
        binanceRow("BTCUSDT", { volume: 900_000_000 }),
        binanceRow("ETHUSDT", { volume: 1_500_000_000 }),
        binanceRow("SOLUSDT", { volume: 300_000_000 }),
      ]),
    });
    const top = await screener.topMarkets();
    expect(top.map((t) => t.symbol)).toEqual(["ETHUSDT", "BTCUSDT", "SOLUSDT"]);
  });

  it("filters out a pair below the volume floor", async () => {
    const screener = new CexScreener({
      fetchFn: stubFetch([binanceRow("SHIBUSDT", { volume: DEFAULT_SCREENER_FILTERS.minQuoteVolume24hUsd - 1 })]),
    });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("filters out a pair that moved further than the sane 24h bound", async () => {
    const screener = new CexScreener({
      fetchFn: stubFetch([binanceRow("PUMPUSDT", { changePct: DEFAULT_SCREENER_FILTERS.maxPriceChangePct24h + 5 })]),
    });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("filters out stablecoin-to-stablecoin pairs", async () => {
    const screener = new CexScreener({
      fetchFn: stubFetch([binanceRow("USDCUSDT", { volume: 200_000_000 })]),
    });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("respects the limit", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => binanceRow(`TOK${i}USDT`, { volume: 100_000_000 + i }));
    const screener = new CexScreener({ fetchFn: stubFetch(rows) });
    expect(await screener.topMarkets({ limit: 5 })).toHaveLength(5);
  });

  it("falls back to bybit when binance's bulk endpoint fails", async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("binance")) throw new Error("network down");
      if (url.includes("bybit")) {
        return new Response(
          JSON.stringify({
            result: {
              list: [{ symbol: "ETHUSDT", lastPrice: "3000", turnover24h: "80000000", price24hPcnt: "0.02" }],
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const screener = new CexScreener({ fetchFn });
    const top = await screener.topMarkets();
    expect(top).toHaveLength(1);
    expect(top[0]!.symbol).toBe("ETHUSDT");
    expect(top[0]!.priceChangePct24h).toBeCloseTo(2, 6);
  });

  it("throws when every exchange fails, naming each failure", async () => {
    const screener = new CexScreener({
      fetchFn: (async () => { throw new Error("down"); }) as unknown as typeof fetch,
    });
    await expect(screener.topMarkets()).rejects.toThrow(/binance.*down.*bybit.*down.*okx.*down/s);
  });

  it("parses OKX's bulk tickers, converting its instId and computing 24h change from open24h", async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("okx")) {
        return new Response(
          JSON.stringify({ data: [{ instId: "BTC-USDT", last: "63000", open24h: "60000", volCcy24h: "500000000" }] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const screener = new CexScreener({ exchanges: ["okx"], fetchFn });
    const top = await screener.topMarkets();
    expect(top).toHaveLength(1);
    expect(top[0]!.symbol).toBe("BTCUSDT");
    expect(top[0]!.priceChangePct24h).toBeCloseTo(5, 6); // 63000 vs 60000 open
    expect(top[0]!.sources).toEqual(["okx"]);
  });

  it("aggregates every exchange at once rather than stopping at the first success", async () => {
    // Both binance and bybit succeed with disjoint symbols — both must
    // contribute, not just whichever was tried first.
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("binance")) return new Response(JSON.stringify([binanceRow("BTCUSDT", { volume: 900_000_000 })]), { status: 200 });
      if (url.includes("bybit")) {
        return new Response(
          JSON.stringify({ result: { list: [{ symbol: "SOLUSDT", lastPrice: "150", turnover24h: "300000000", price24hPcnt: "0.03" }] } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const screener = new CexScreener({ exchanges: ["binance", "bybit"], fetchFn });
    const top = await screener.topMarkets();
    expect(top.map((t) => t.symbol).sort()).toEqual(["BTCUSDT", "SOLUSDT"]);
  });

  it("merges a symbol both exchanges list, keeping the higher-volume reading and recording both sources", async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("binance")) return new Response(JSON.stringify([binanceRow("BTCUSDT", { volume: 900_000_000, price: 63_000 })]), { status: 200 });
      if (url.includes("bybit")) {
        return new Response(
          JSON.stringify({ result: { list: [{ symbol: "BTCUSDT", lastPrice: "63010", turnover24h: "1200000000", price24hPcnt: "0.025" }] } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const screener = new CexScreener({ exchanges: ["binance", "bybit"], fetchFn });
    const top = await screener.topMarkets();
    expect(top).toHaveLength(1);
    expect(top[0]!.quoteVolume24hUsd).toBe(1_200_000_000); // bybit's higher figure wins
    expect(top[0]!.sources.sort()).toEqual(["binance", "bybit"]);
  });

  it("ignores an exchange passed in that has no bulk stats source", async () => {
    const screener = new CexScreener({ exchanges: ["kucoin"] });
    await expect(screener.topMarkets()).rejects.toThrow();
  });
});

describe("news-driven symbol lookup", () => {
  const stats = [
    { symbol: "BTCUSDT", priceUsd: 63_000, quoteVolume24hUsd: 900_000_000, priceChangePct24h: 2, sources: ["binance"] as const },
    { symbol: "TINYUSDT", priceUsd: 0.02, quoteVolume24hUsd: 3_000_000, priceChangePct24h: 5, sources: ["binance"] as const },
    { symbol: "DEADUSDT", priceUsd: 0.001, quoteVolume24hUsd: 100_000, priceChangePct24h: 1, sources: ["binance"] as const },
    { symbol: "PUMPUSDT", priceUsd: 1, quoteVolume24hUsd: 5_000_000, priceChangePct24h: 90, sources: ["binance"] as const },
    { symbol: "USDCUSDT", priceUsd: 1, quoteVolume24hUsd: 50_000_000, priceChangePct24h: 0, sources: ["binance"] as const },
  ];

  it("finds a news-mentioned symbol below the normal top-markets volume floor", async () => {
    const screener = new CexScreener();
    const result = screener.bySymbol(stats, ["TINYUSDT"]);
    expect(result.map((r) => r.symbol)).toEqual(["TINYUSDT"]);
  });

  it("still rejects a symbol below even the reduced news floor", async () => {
    const screener = new CexScreener();
    expect(screener.bySymbol(stats, ["DEADUSDT"])).toEqual([]);
  });

  it("still rejects a symbol moving too fast to be a stable read", async () => {
    const screener = new CexScreener();
    expect(screener.bySymbol(stats, ["PUMPUSDT"])).toEqual([]);
  });

  it("still rejects a stablecoin pair even if a headline names it", async () => {
    const screener = new CexScreener();
    expect(screener.bySymbol(stats, ["USDCUSDT"])).toEqual([]);
  });

  it("ignores a symbol not present in the stats at all, rather than inventing one", async () => {
    const screener = new CexScreener();
    expect(screener.bySymbol(stats, ["NOTLISTEDUSDT"])).toEqual([]);
  });

  it("allStats exposes the unfiltered, unranked data topMarkets works from", async () => {
    const screener = new CexScreener({
      fetchFn: stubFetch([binanceRow("BTCUSDT"), binanceRow("SHIBUSDT", { volume: 1 })]),
    });
    const all = await screener.allStats();
    expect(all.map((s) => s.symbol).sort()).toEqual(["BTCUSDT", "SHIBUSDT"]);
  });

  it("topMarkets accepts already-fetched stats, avoiding a second network round-trip", async () => {
    let calls = 0;
    const fetchFn = (async (input: string | URL) => {
      calls++;
      return stubFetch([binanceRow("BTCUSDT")])(input as never);
    }) as unknown as typeof fetch;
    const screener = new CexScreener({ fetchFn });
    const all = await screener.allStats();
    const callsAfterFirst = calls;
    await screener.topMarkets({ stats: all });
    expect(calls).toBe(callsAfterFirst);
  });
});
