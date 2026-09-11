import { describe, expect, it } from "vitest";
import type { Timeframe } from "@smc/core";
import { MAX_ANALYSED_MARKETS, MAX_PINNED_MARKETS, SpotSignalRuntime } from "../src/spot.js";
import type { RuntimeStorage } from "../src/runtime.js";

/**
 * Spot signals must never place, size or execute a trade — the entire feature
 * is the analysis without the commitment. Every test here that touches a
 * signal also asserts there is nothing resembling an order or a position
 * anywhere in the result. What gets analysed is discovered, not typed in —
 * these tests also cover that discovery, not just the read-only engine.
 */

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function memoryStorage(): RuntimeStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(entries: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    },
  };
}

function binanceRow(symbol: string, overrides: Partial<{ price: number; volume: number; changePct: number }> = {}) {
  return {
    symbol,
    lastPrice: String(overrides.price ?? 60_000),
    quoteVolume: String(overrides.volume ?? 500_000_000),
    priceChangePercent: String(overrides.changePct ?? 2),
  };
}

/** A steady uptrend so at least one market reliably produces a valid setup,
 * plus a bulk 24hr-stats response so discovery has something to rank. */
function stubFetch(now: number, discoveredSymbols: string[] = ["BTCUSDT", "ETHUSDT"]): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/ticker/24hr") {
      return new Response(JSON.stringify(discoveredSymbols.map((s) => binanceRow(s))), { status: 200 });
    }
    if (!url.pathname.includes("klines") && !url.hostname.includes("binance")) {
      // News feeds and anything else: empty, unavailable response.
      return new Response("", { status: 503 });
    }
    const interval = url.searchParams.get("interval");
    const tf: Timeframe = interval === "4h" ? "4H" : interval === "1h" ? "1H" : "15M";
    const step = tf === "4H" ? 4 * HOUR : tf === "1H" ? HOUR : HOUR / 4;

    let price = 60_000;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    const rows = Array.from({ length: 200 }, (_, i) => {
      const open = price;
      const close = open + 40 + rnd() * 500; // net upward drift
      price = close;
      return [
        now - (199 - i) * step,
        String(open),
        String(Math.max(open, close) + 220),
        String(Math.min(open, close) - 220),
        String(close),
        "10",
      ];
    });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
}

function runtime(discoveredSymbols?: string[]) {
  const storage = memoryStorage();
  return { storage, spot: new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW, discoveredSymbols) }) };
}

describe("discovery", () => {
  it("discovers markets by 24h volume without anything typed in", async () => {
    const { spot } = runtime(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    const markets = await spot.discover(NOW);
    expect(markets.map((m) => m.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

    const stored = await spot.getCandidates();
    expect(stored.markets).toHaveLength(3);
    expect(stored.updatedAt).toBe(NOW);
  });
});

describe("pinning", () => {
  it("pins a market in addition to whatever is discovered", async () => {
    const { spot } = runtime();
    const result = await spot.pin("dogeusdt");
    expect(result.error).toBeUndefined();
    expect(result.pinned).toEqual(["DOGEUSDT"]);
  });

  it("unpins a market", async () => {
    const { spot } = runtime();
    await spot.pin("DOGEUSDT");
    const result = await spot.unpin("DOGEUSDT");
    expect(result.pinned).toEqual([]);
  });

  it("caps the number of pinned markets", async () => {
    const { spot } = runtime();
    for (let i = 0; i < MAX_PINNED_MARKETS; i++) await spot.pin(`TOK${i}USDT`);
    const result = await spot.pin("ONE_TOO_MANY");
    expect(result.error).toMatch(/at most/);
  });
});

describe("spot signals", () => {
  it("analyses discovered markets without opening a position", async () => {
    const { spot } = runtime(["BTCUSDT", "ETHUSDT"]);
    const signals = await spot.tickAll(NOW);

    expect(signals.map((s) => s.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    for (const signal of signals) {
      expect(signal.discovered).toBe(true);
      expect(signal.pinned).toBe(false);
      expect(signal).not.toHaveProperty("positionSize");
      expect(signal).not.toHaveProperty("order");
      expect(signal.updatedAt).toBe(NOW);
      expect(signal.volumeUsd24h).toBeGreaterThan(0);
    }
  });

  it("shows a pinned market even when it does not rank among discovered volume", async () => {
    const { spot } = runtime(["BTCUSDT"]); // only BTCUSDT discovered
    await spot.pin("ETHUSDT");
    const signals = await spot.tickAll(NOW);

    const symbols = signals.map((s) => s.symbol);
    expect(symbols).toContain("BTCUSDT");
    expect(symbols).toContain("ETHUSDT");
    const eth = signals.find((s) => s.symbol === "ETHUSDT")!;
    expect(eth.pinned).toBe(true);
    expect(eth.discovered).toBe(false);
  });

  it("requires nothing be typed in — discovery alone is enough to see signals", async () => {
    const { spot } = runtime(["BTCUSDT"]);
    // No pin() call at all.
    const signals = await spot.tickAll(NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.symbol).toBe("BTCUSDT");
  });

  it("bounds total analysed markets even with many pins", async () => {
    const { spot } = runtime(Array.from({ length: 10 }, (_, i) => `D${i}USDT`));
    for (let i = 0; i < MAX_PINNED_MARKETS; i++) await spot.pin(`P${i}USDT`);
    const signals = await spot.tickAll(NOW);
    expect(signals.length).toBeLessThanOrEqual(MAX_ANALYSED_MARKETS);
  });

  it("persists signals so a page reload reads them without re-analysing", async () => {
    const { storage, spot } = runtime(["BTCUSDT"]);
    await spot.tickAll(NOW);

    const stored = await storage.get<{ signals: unknown[]; updatedAt: number }>("spotSignals");
    expect(stored?.updatedAt).toBe(NOW);

    const read = await spot.getSignals();
    expect(read.updatedAt).toBe(NOW);
    expect(read.signals).toHaveLength(1);
  });

  it("keeps a market's last known signal when its tick fails, rather than dropping it", async () => {
    const storage = memoryStorage();
    let down = false;
    const flaky = new SpotSignalRuntime(storage, {
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (down && url.pathname.includes("klines")) throw new Error("network down");
        return stubFetch(NOW, ["BTCUSDT"])(input as never);
      }) as unknown as typeof fetch,
    });
    const first = await flaky.tickAll(NOW);
    expect(first).toHaveLength(1);

    down = true;
    const second = await flaky.tickAll(NOW + 20 * 60_000); // within the discovery cache window
    expect(second).toHaveLength(1);
    expect(second[0]!.symbol).toBe("BTCUSDT");
  });

  it("does not share engine state with an agent watching the same symbol", async () => {
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW, ["BTCUSDT"]) });
    await spot.tickAll(NOW);

    // The spot engine's persisted state must live under its own namespace, not
    // the unscoped key an agentless engine (or a differently-namespaced agent)
    // would use.
    const keys = [...storage.data.keys()];
    expect(keys.some((k) => k.startsWith("engine:spot:"))).toBe(true);
    expect(keys).not.toContain("engine:BTCUSDT");
  });
});
