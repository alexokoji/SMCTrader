import { describe, expect, it } from "vitest";
import type { Candle, Timeframe } from "@smc/core";
import {
  CANDLE_BUFFER,
  HYDRATION_BUDGET,
  STEADY_TICK_MS,
  TradingRuntime,
  WARMING_TICK_MS,
  closedCandlesOnly,
  mergeCandles,
  type RuntimeStorage,
} from "../src/runtime.js";

const HOUR = 3_600_000;

function candle(tf: Timeframe, timestamp: number, close: number): Candle {
  return {
    symbol: "BTCUSDT",
    exchange: "binance",
    timeframe: tf,
    timestamp,
    open: close - 10,
    high: close + 20,
    low: close - 20,
    close,
    volume: 1,
  };
}

/** Deterministic candle series with a real impulse/pullback shape. */
function series(tf: Timeframe, count: number, stepMs: number, startTs: number): Candle[] {
  let price = 100_000;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  return Array.from({ length: count }, (_, i) => {
    const open = price;
    const close = open + rnd() * 800;
    const high = Math.max(open, close) + Math.abs(rnd()) * 300;
    const low = Math.min(open, close) - Math.abs(rnd()) * 300;
    price = close;
    return {
      symbol: "BTCUSDT",
      exchange: "binance",
      timeframe: tf,
      timestamp: startTs + i * stepMs,
      open, high, low, close,
      volume: 10 + Math.abs(rnd()),
    };
  });
}

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

/** Serves candles for any requested timeframe from a fixed generated history. */
function stubFetch(now: number, counts: Partial<Record<Timeframe, number>> = {}): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const tf: Timeframe = url.searchParams.get("interval") === "4h" ? "4H"
      : url.searchParams.get("interval") === "1h" ? "1H"
      : "15M";
    const step = tf === "4H" ? 4 * HOUR : tf === "1H" ? HOUR : HOUR / 4;
    const count = counts[tf] ?? 200;
    const rows = series(tf, count, step, now - count * step).map((c) => [
      c.timestamp, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume),
    ]);
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("mergeCandles", () => {
  it("de-duplicates by open time and lets the newest fetch replace a re-stated bar", () => {
    const stored = [candle("1H", 1_000, 100), candle("1H", 2_000, 200)];
    const incoming = [candle("1H", 2_000, 250), candle("1H", 3_000, 300)];
    const merged = mergeCandles(stored, incoming);
    expect(merged.map((c) => c.timestamp)).toEqual([1_000, 2_000, 3_000]);
    expect(merged[1].close).toBe(250);
  });

  it("bounds the buffer so storage and replay cost stay predictable", () => {
    const many = Array.from({ length: CANDLE_BUFFER + 60 }, (_, i) => candle("1H", i * HOUR, 100 + i));
    expect(mergeCandles([], many)).toHaveLength(CANDLE_BUFFER);
  });
});

describe("closedCandlesOnly", () => {
  it("excludes a bar that has not closed yet, preventing retroactive structure", () => {
    const now = 10 * HOUR;
    const candles = [candle("1H", 8 * HOUR, 100), candle("1H", 9 * HOUR, 110), candle("1H", 10 * HOUR, 120)];
    const closed = closedCandlesOnly(candles, HOUR, now);
    expect(closed.map((c) => c.timestamp)).toEqual([8 * HOUR, 9 * HOUR]);
  });
});

describe("TradingRuntime", () => {
  const baseOpts = {
    mode: "PAPER" as const,
    risk: {},
    autoTrading: false,
    safetyBlocked: false,
  };

  it("produces analysis from the real SMC engine rather than a placeholder signal", async () => {
    const now = 1_800_000_000_000;
    const runtime = new TradingRuntime(memoryStorage(), { fetchFn: stubFetch(now) });

    let tick = await runtime.tick("BTCUSDT", { ...baseOpts, now });
    // Warm up fully so the analysis is authoritative.
    for (let i = 0; i < 12 && tick.warming; i++) {
      tick = await runtime.tick("BTCUSDT", { ...baseOpts, now });
    }

    expect(tick.warming).toBe(false);
    // Real engine output: per-timeframe structure snapshots the placeholder
    // never produced.
    expect(tick.analysis.snapshots).toBeDefined();
    expect(tick.analysis.topDown.htf.timeframe).toBe("4H");
    expect(["BULLISH", "BEARISH", "NEUTRAL", "UNCLEAR"]).toContain(tick.analysis.bias);
    // No setup may claim the placeholder's fabricated entry model.
    for (const setup of tick.analysis.setups) {
      expect(setup.entryModel).not.toBe("SMA momentum + structure");
      expect(["AGGRESSIVE", "CONFIRMATION", "SWEEP", "COUNTER_TREND"]).toContain(setup.entryModel);
      expect(setup.hardRules.length).toBeGreaterThan(0);
    }
  });

  it("spreads a cold replay across ticks so no single invocation blows the CPU budget", async () => {
    const now = 1_800_000_000_000;
    const runtime = new TradingRuntime(memoryStorage(), { fetchFn: stubFetch(now), hydrationBudget: 150 });

    const first = await runtime.tick("BTCUSDT", { ...baseOpts, now });
    expect(first.warming).toBe(true);
    expect(first.status).toBe("WARMING_UP");
    expect(first.message).toMatch(/remaining/);

    let ticks = 1;
    let tick = first;
    while (tick.warming && ticks < 20) {
      tick = await runtime.tick("BTCUSDT", { ...baseOpts, now });
      ticks++;
    }
    expect(tick.warming).toBe(false);
    // More than one tick was required, proving the work was actually chunked.
    expect(ticks).toBeGreaterThan(1);
  });

  it("never feeds more than the hydration budget in one invocation", async () => {
    const now = 1_800_000_000_000;
    const storage = memoryStorage();
    const runtime = new TradingRuntime(storage, { fetchFn: stubFetch(now), hydrationBudget: 150 });
    const tick = await runtime.tick("BTCUSDT", { ...baseOpts, now });
    const engine = runtime.engineFor("BTCUSDT")!;
    const fed = (["4H", "1H", "15M"] as Timeframe[])
      .reduce((sum, tf) => sum + engine.analysis.candlesFor(tf).length, 0);
    expect(fed).toBeLessThanOrEqual(150);
    expect(tick.warming).toBe(true);
  });

  it("restores engine state after an eviction instead of losing the audit trail", async () => {
    const now = 1_800_000_000_000;
    const storage = memoryStorage();
    const first = new TradingRuntime(storage, { fetchFn: stubFetch(now) });
    let tick = await first.tick("BTCUSDT", { ...baseOpts, now });
    for (let i = 0; i < 12 && tick.warming; i++) {
      tick = await first.tick("BTCUSDT", { ...baseOpts, now });
    }
    const before = first.engineFor("BTCUSDT")!.serialize();

    // A new runtime over the same storage simulates a Durable Object eviction.
    const revived = new TradingRuntime(storage, { fetchFn: stubFetch(now) });
    await revived.tick("BTCUSDT", { ...baseOpts, now });
    const after = revived.engineFor("BTCUSDT")!.serialize();

    expect(after.journal.length).toBeGreaterThanOrEqual(before.journal.length);
    expect(after.risk.equity).toBeCloseTo(before.risk.equity, 6);
    expect(after.positions.length).toBe(before.positions.length);
  });

  it("replays stored history without calling an exchange, then resumes fetching", async () => {
    const now = 1_800_000_000_000;
    const storage = memoryStorage();
    let fetches = 0;
    const counting = (): typeof fetch => {
      const inner = stubFetch(now);
      return (async (input: string | URL, init?: RequestInit) => {
        fetches++;
        return inner(input as string, init);
      }) as unknown as typeof fetch;
    };

    // One tick populates the candle buffers but leaves most of the history
    // unreplayed, which is the state a cold start actually resumes from.
    const seed = new TradingRuntime(storage, { fetchFn: stubFetch(now), hydrationBudget: 150 });
    const seeded = await seed.tick("BTCUSDT", { ...baseOpts, now });
    expect(seeded.warming).toBe(true);

    // A fresh runtime over the same storage still has a backlog to replay.
    const revived = new TradingRuntime(storage, { fetchFn: counting(), hydrationBudget: 150 });
    const first = await revived.tick("BTCUSDT", { ...baseOpts, now });

    expect(first.warming).toBe(true);
    expect(first.usedStoredHistory).toBe(true);
    // Replaying history must not hit the exchange at all.
    expect(fetches).toBe(0);

    // Once the backlog is drained it goes back to the network for new bars.
    let next = first;
    for (let i = 0; i < 25 && next.usedStoredHistory; i++) {
      next = await revived.tick("BTCUSDT", { ...baseOpts, now });
    }
    expect(next.usedStoredHistory).toBe(false);
    expect(next.warming).toBe(false);
    expect(fetches).toBeGreaterThan(0);
  });

  it("asks to be woken quickly while warming and slowly once caught up", async () => {
    const now = 1_800_000_000_000;
    // A small budget forces a multi-tick warm-up so both cadences are exercised.
    const runtime = new TradingRuntime(memoryStorage(), { fetchFn: stubFetch(now), hydrationBudget: 150 });

    let tick = await runtime.tick("BTCUSDT", { ...baseOpts, now });
    expect(tick.warming).toBe(true);
    expect(tick.nextTickMs).toBe(WARMING_TICK_MS);

    for (let i = 0; i < 20 && tick.warming; i++) {
      tick = await runtime.tick("BTCUSDT", { ...baseOpts, now });
    }
    expect(tick.warming).toBe(false);
    expect(tick.nextTickMs).toBe(STEADY_TICK_MS);
    expect(WARMING_TICK_MS).toBeLessThan(STEADY_TICK_MS);
  });

  it("loads candles into a rebuilt engine after an eviction", async () => {
    const now = 1_800_000_000_000;
    const storage = memoryStorage();

    // Seed storage with a full candle history.
    const seed = new TradingRuntime(storage, { fetchFn: stubFetch(now) });
    await seed.tick("BTCUSDT", { ...baseOpts, now });

    // A brand new runtime is what a Durable Object evicted between alarms gets.
    // Its analysis engine has no candles, so it must replay the stored buffer
    // rather than trusting any record of previous progress.
    const revived = new TradingRuntime(storage, { fetchFn: stubFetch(now) });
    const tick = await revived.tick("BTCUSDT", { ...baseOpts, now });
    const engine = revived.engineFor("BTCUSDT")!;

    const fed = (["4H", "1H", "15M"] as Timeframe[])
      .reduce((sum, tf) => sum + engine.analysis.candlesFor(tf).length, 0);
    // Marking a rebuilt engine as warm while it held zero candles left it
    // permanently unable to form a bias.
    expect(fed).toBeGreaterThan(0);
    expect(tick.warming).toBe(false);
    expect(tick.analysis.snapshots["15M"]!.candles.length).toBeGreaterThan(30);
  });

  it("keeps stored history when every market data provider fails", async () => {
    const now = 1_800_000_000_000;
    const storage = memoryStorage();
    const runtime = new TradingRuntime(storage, { fetchFn: stubFetch(now) });
    await runtime.tick("BTCUSDT", { ...baseOpts, now });
    const storedBefore = (await storage.get<Candle[]>("candles:BTCUSDT:1H"))!.length;
    expect(storedBefore).toBeGreaterThan(0);

    const failing = new TradingRuntime(storage, {
      fetchFn: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(failing.tick("BTCUSDT", { ...baseOpts, now })).resolves.toBeDefined();
    expect((await storage.get<Candle[]>("candles:BTCUSDT:1H"))!.length).toBe(storedBefore);
  });
});
