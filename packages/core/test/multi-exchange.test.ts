import { describe, expect, it } from "vitest";
import { MultiExchangeMarketData } from "../src/marketdata/multi-exchange.js";

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("MultiExchangeMarketData", () => {
  it("falls back from an unavailable exchange and normalizes Bybit candles", async () => {
    const provider = new MultiExchangeMarketData({
      exchanges: ["binance", "bybit"],
      fetchFn: async (url) => {
        if (String(url).includes("binance")) throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
        return response({ result: { list: [["1700000000000", "10", "12", "8", "11", "123"]] } });
      },
    });
    const candles = await provider.getOHLCV("BTCUSDT", "15M", 1, 2, 1);
    expect(candles).toEqual([expect.objectContaining({ exchange: "bybit", open: 10, high: 12, low: 8, close: 11, volume: 123 })]);
  });

  it("normalizes an OKX ticker symbol and price", async () => {
    const provider = new MultiExchangeMarketData({
      exchanges: ["okx"],
      fetchFn: async (url) => {
        expect(String(url)).toContain("instId=BTC-USDT");
        return response({ data: [{ last: "62500.5" }] });
      },
    });
    await expect(provider.getTicker("BTCUSDT")).resolves.toEqual({ price: 62500.5 });
  });
});
