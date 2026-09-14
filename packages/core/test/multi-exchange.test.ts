import { describe, expect, it } from "vitest";
import { MultiExchangeMarketData, isSubrequestCeilingError } from "../src/marketdata/multi-exchange.js";

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

  describe("subrequest ceiling", () => {
    it("recognises Cloudflare's per-invocation subrequest ceiling message", () => {
      expect(isSubrequestCeilingError(new Error("Too many subrequests by single Worker invocation."))).toBe(true);
      expect(isSubrequestCeilingError(new Error("fetch failed"))).toBe(false);
      expect(isSubrequestCeilingError("not even an Error")).toBe(false);
    });

    it("stops trying further exchanges once the ceiling is hit, rather than exhausting the fallback chain", async () => {
      // Once one exchange reports the ceiling, every remaining exchange in
      // the same invocation is doomed too — trying them anyway is exactly
      // what turned one ceiling hit into a cascade of wasted calls in
      // production. This asserts the fix: the second and third exchanges
      // are never even attempted.
      const attempted: string[] = [];
      const provider = new MultiExchangeMarketData({
        exchanges: ["binance", "bybit", "okx"],
        fetchFn: async (url) => {
          const exchange = String(url).includes("binance") ? "binance" : String(url).includes("bybit") ? "bybit" : "okx";
          attempted.push(exchange);
          throw new Error("Too many subrequests by single Worker invocation.");
        },
      });

      await expect(provider.getOHLCV("BTCUSDT", "15M", 1, 2, 1)).rejects.toThrow();
      expect(attempted).toEqual(["binance"]);
    });

    it("still tries every exchange for an ordinary (non-ceiling) failure", async () => {
      const attempted: string[] = [];
      const provider = new MultiExchangeMarketData({
        exchanges: ["binance", "bybit", "okx"],
        fetchFn: async (url) => {
          const exchange = String(url).includes("binance") ? "binance" : String(url).includes("bybit") ? "bybit" : "okx";
          attempted.push(exchange);
          throw new Error("network unreachable");
        },
      });

      await expect(provider.getOHLCV("BTCUSDT", "15M", 1, 2, 1)).rejects.toThrow();
      expect(attempted).toEqual(["binance", "bybit", "okx"]);
    });
  });
});
