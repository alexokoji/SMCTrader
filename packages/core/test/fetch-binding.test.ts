import { afterEach, describe, expect, it } from "vitest";
import { MultiExchangeMarketData } from "../src/marketdata/multi-exchange.js";
import { BinanceMarketData } from "../src/marketdata/providers.js";

/**
 * Reproduces a production failure: the Cloudflare Workers runtime rejects the
 * global `fetch` when it is invoked with any receiver other than the global
 * object, raising "Illegal invocation". Node is permissive, so a provider that
 * stored `fetch` on itself and called `this.fetchFn(...)` passed every local
 * test while failing every request in the Worker.
 *
 * The stub below enforces the Workers rule, so the mistake fails here first.
 */
const realFetch = globalThis.fetch;

function installStrictFetch(body: unknown): { calls: number } {
  const state = { calls: 0 };
  const strict = function (this: unknown) {
    // `this` is undefined for a plain call, or globalThis in sloppy mode.
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    state.calls++;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  globalThis.fetch = strict as unknown as typeof fetch;
  return state;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const KLINES = [[1_700_000_000_000, "100", "110", "95", "105", "12"]];

describe("market data providers call the global fetch correctly", () => {
  it("MultiExchangeMarketData does not bind fetch to itself", async () => {
    const state = installStrictFetch(KLINES);
    const provider = new MultiExchangeMarketData({ exchanges: ["binance"] });

    const candles = await provider.getOHLCV("BTCUSDT", "1H", 0, 1_700_000_100_000, 10);

    expect(state.calls).toBe(1);
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(105);
  });

  it("BinanceMarketData does not bind fetch to itself", async () => {
    const state = installStrictFetch(KLINES);
    const provider = new BinanceMarketData();

    const candles = await provider.getOHLCV("BTCUSDT", "1H", 0, 1_700_000_100_000, 10);

    expect(state.calls).toBe(1);
    expect(candles[0].high).toBe(110);
  });

  it("still honours an explicitly injected fetch implementation", async () => {
    installStrictFetch(KLINES);
    let injected = 0;
    const provider = new MultiExchangeMarketData({
      exchanges: ["binance"],
      fetchFn: (async () => {
        injected++;
        return new Response(JSON.stringify(KLINES), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await provider.getOHLCV("BTCUSDT", "1H", 0, 1_700_000_100_000, 10);
    expect(injected).toBe(1);
  });

  it("surfaces the illegal-invocation error if a provider ever rebinds fetch again", () => {
    installStrictFetch(KLINES);
    // A provider written the old way: fetch stored bare, called as a method.
    // The receiver check throws synchronously, before any promise is returned.
    const broken = {
      fetchFn: globalThis.fetch,
      run() { return this.fetchFn("https://example.com"); },
    };
    expect(() => broken.run()).toThrow(/Illegal invocation/);
  });
});
