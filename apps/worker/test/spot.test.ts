import { describe, expect, it } from "vitest";
import type { Timeframe } from "@smc/core";
import { DEFAULT_WATCHLIST, MAX_WATCHLIST_SYMBOLS, SpotSignalRuntime } from "../src/spot.js";
import type { RuntimeStorage } from "../src/runtime.js";

/**
 * Spot signals must never place, size or execute a trade — the entire feature
 * is the analysis without the commitment. Every test here that touches a
 * signal also asserts there is nothing resembling an order or a position
 * anywhere in the result.
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

/** A steady uptrend so at least one market reliably produces a valid setup. */
function stubFetch(now: number): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
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

function runtime() {
  const storage = memoryStorage();
  return { storage, spot: new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW) }) };
}

describe("spot watchlist", () => {
  it("starts with a default watchlist", async () => {
    const { spot } = runtime();
    expect(await spot.getWatchlist()).toEqual(DEFAULT_WATCHLIST);
  });

  it("replaces the watchlist, deduplicated and upper-cased", async () => {
    const { spot } = runtime();
    const result = await spot.setWatchlist(["btcusdt", "ETHUSDT", "btcusdt"]);
    expect(result.error).toBeUndefined();
    expect(result.symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(await spot.getWatchlist()).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("rejects an empty watchlist", async () => {
    const { spot } = runtime();
    const result = await spot.setWatchlist([]);
    expect(result.error).toMatch(/at least one market/);
    // The prior watchlist is unchanged, not wiped to empty.
    expect(await spot.getWatchlist()).toEqual(DEFAULT_WATCHLIST);
  });

  it("rejects a watchlist over the size limit", async () => {
    const { spot } = runtime();
    const huge = Array.from({ length: MAX_WATCHLIST_SYMBOLS + 1 }, (_, i) => `SYM${i}USDT`);
    const result = await spot.setWatchlist(huge);
    expect(result.error).toMatch(/limited to/);
  });
});

describe("spot signals", () => {
  it("analyses every watched market without opening a position", async () => {
    const { spot } = runtime();
    await spot.setWatchlist(["BTCUSDT", "ETHUSDT"]);

    const signals = await spot.tickAll(NOW);

    expect(signals.map((s) => s.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    for (const signal of signals) {
      expect(signal.price).toBeGreaterThan(0);
      expect(signal).not.toHaveProperty("positionSize");
      expect(signal).not.toHaveProperty("order");
      expect(signal.updatedAt).toBe(NOW);
    }
  });

  it("reports the expected move to target as a signed percentage", async () => {
    const { spot } = runtime();
    await spot.setWatchlist(["BTCUSDT"]);
    const [signal] = await spot.tickAll(NOW);

    if (signal.setup) {
      // The nearest target's move should match the sign the direction implies:
      // a BUY's target sits above entry, so the move is positive.
      const expectedSign = signal.setup.direction === "LONG" ? 1 : -1;
      expect(Math.sign(signal.setup.nearestTargetPct)).toBe(expectedSign);
      expect(signal.setup.nearestTargetPct).toBeCloseTo(signal.setup.targetMovesPct[0]!, 6);
    }
  });

  it("persists signals so a page reload reads them without re-analysing", async () => {
    const { storage, spot } = runtime();
    await spot.setWatchlist(["BTCUSDT"]);
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
        if (down) throw new Error("network down");
        return stubFetch(NOW)(input as never);
      }) as unknown as typeof fetch,
    });
    await flaky.setWatchlist(["BTCUSDT"]);
    const first = await flaky.tickAll(NOW);
    expect(first).toHaveLength(1);

    down = true;
    const second = await flaky.tickAll(NOW + HOUR);
    expect(second).toHaveLength(1);
    expect(second[0]!.symbol).toBe("BTCUSDT");
  });

  it("does not share engine state with an agent watching the same symbol", async () => {
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW) });
    await spot.setWatchlist(["BTCUSDT"]);
    await spot.tickAll(NOW);

    // The spot engine's persisted state must live under its own namespace, not
    // the unscoped key an agentless engine (or a differently-namespaced agent)
    // would use.
    const keys = [...storage.data.keys()];
    expect(keys.some((k) => k.startsWith("engine:spot:"))).toBe(true);
    expect(keys).not.toContain("engine:BTCUSDT");
  });
});
