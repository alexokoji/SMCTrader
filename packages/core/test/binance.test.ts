import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { BinanceExecutionAdapter } from "../src/execution/binance.js";
import type { OrderRequest } from "../src/execution/types.js";

const API_KEY = "test-key";
const API_SECRET = "test-secret";
const BASE = "https://api.binance.com";

function verifySignature(url: string): void {
  const q = new URL(url);
  const signature = q.searchParams.get("signature");
  expect(signature).toBeTruthy();
  const params = new URLSearchParams(q.search);
  params.delete("signature");
  const expected = createHmac("sha256", API_SECRET).update(params.toString()).digest("hex");
  expect(signature).toBe(expected);
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return async (url: string, init?: RequestInit) => {
    const data = handler(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    } as Response;
  };
}

describe("BinanceExecutionAdapter", () => {
  it("rejects construction without credentials", () => {
    expect(() => new BinanceExecutionAdapter({ apiKey: "", apiSecret: "" })).toThrow();
  });

  it("connects via the public time endpoint", async () => {
    const adapter = new BinanceExecutionAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      baseUrl: BASE,
      fetchFn: mockFetch(() => ({ serverTime: 123 })),
    });
    const status = await adapter.connect();
    expect(status.connected).toBe(true);
  });

  it("validates credentials with a signed account request", async () => {
    let seenUrl = "";
    const adapter = new BinanceExecutionAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      baseUrl: BASE,
      fetchFn: mockFetch((url) => {
        seenUrl = url;
        return { balances: [{ asset: "USDT", free: "5000", locked: "0" }] };
      }),
    });
    const result = await adapter.validateCredentials();
    expect(result.valid).toBe(true);
    expect(result.permissions.tradingEnabled).toBe(true);
    verifySignature(seenUrl);
  });

  it("computes USDT equity from account balances", async () => {
    const adapter = new BinanceExecutionAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      baseUrl: BASE,
      fetchFn: mockFetch((url) => {
        if (url.includes("/api/v3/ticker/price")) return { price: "2" };
        return { balances: [{ asset: "USDT", free: "4000", locked: "500" }, { asset: "BTC", free: "1", locked: "0" }] };
      }),
    });
    const balance = await adapter.getAccountBalance();
    expect(balance.totalEquity).toBe(4500 + 2);
    expect(balance.available).toBe(4000 + 2);
  });

  it("fetches ticker, klines and trading rules from public endpoints", async () => {
    const adapter = new BinanceExecutionAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      baseUrl: BASE,
      fetchFn: mockFetch((url) => {
        if (url.includes("ticker/price")) return { price: "60000" };
        if (url.includes("klines")) return [[1_700_000_000_000, "1", "2", "3", "4", "100"]];
        if (url.includes("exchangeInfo")) {
          return {
            symbols: [
              {
                symbol: "BTCUSDT",
                status: "TRADING",
                quoteAsset: "USDT",
                baseAssetPrecision: 8,
                quoteAssetPrecision: 2,
                filters: [
                  { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "9000", stepSize: "0.001" },
                  { filterType: "MIN_NOTIONAL", minNotional: "5" },
                ],
              },
            ],
          };
        }
        return {};
      }),
    });

    expect((await adapter.getTicker("BTCUSDT")).price).toBe(60000);
    const candles = await adapter.getOHLCV("BTCUSDT", "15M", 10);
    expect(candles[0].close).toBe(4);
    expect(candles[0].timeframe).toBe("15M");

    const rules = await adapter.getTradingRules("BTCUSDT");
    expect(rules.stepSize).toBe(0.001);
    expect(rules.minNotional).toBe(5);
    expect(rules.pricePrecision).toBe(2);
  });

  it("places a signed limit order and reports the fill", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const adapter = new BinanceExecutionAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      baseUrl: BASE,
      fetchFn: mockFetch((url, init) => {
        seen = { url, init };
        return {
          orderId: 777,
          symbol: "BTCUSDT",
          side: "BUY",
          status: "FILLED",
          price: "60000",
          executedQty: "0.001",
          cummulativeQuoteQty: "60",
        };
      }),
    });
    const order: OrderRequest = {
      symbol: "BTCUSDT",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 0.001,
      price: 60000,
    };
    const result = await adapter.placeOrder(order);
    expect(result.status).toBe("FILLED");
    expect(result.orderId).toBe("777");
    expect(result.filledQuantity).toBe(0.001);
    expect(seen?.init?.method).toBe("POST");
    expect((seen?.init?.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(API_KEY);
    verifySignature(seen!.url);
  });

  it("returns PARTIAL for partially filled orders", async () => {
    const adapter = new BinanceExecutionAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      baseUrl: BASE,
      fetchFn: mockFetch(() => ({
        orderId: 8,
        symbol: "BTCUSDT",
        side: "BUY",
        status: "PARTIALLY_FILLED",
        price: "60000",
        executedQty: "0.0005",
        cummulativeQuoteQty: "30",
      })),
    });
    const result = await adapter.placeOrder({ symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quantity: 0.001 });
    expect(result.status).toBe("PARTIAL");
  });

  it("surfaces API errors with the exchange message", async () => {
    const adapter = new BinanceExecutionAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      baseUrl: BASE,
      fetchFn: async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({ code: -2010, msg: "Account has insufficient balance" }),
          text: async () => "",
        }) as Response,
    });
    await expect(adapter.getAccountBalance()).rejects.toThrow(/insufficient balance/);
  });

  it("cancels orders with a signed DELETE", async () => {
    let method = "";
    const adapter = new BinanceExecutionAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      baseUrl: BASE,
      fetchFn: mockFetch((_url, init) => {
        method = init?.method ?? "";
        return { orderId: 1 };
      }),
    });
    expect(await adapter.cancelOrder("1")).toBe(true);
    expect(method).toBe("DELETE");
  });
});
