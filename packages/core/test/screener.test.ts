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
    await expect(screener.topMarkets()).rejects.toThrow(/binance.*down.*bybit.*down/s);
  });
});
