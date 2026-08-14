import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG, StrategyEngine, type Candle, type Timeframe } from "@smc/core";
import { DailyRolloverScheduler, utcDayKey } from "../src/scheduler.js";
import { PollingFeedService } from "../src/feed.js";

function mkCandle(openTime: number, timeframe: Timeframe, close: number): Candle {
  return { symbol: "BTCUSDT", exchange: "test", timeframe, timestamp: openTime, open: close, high: close, low: close, close, volume: 1 };
}

describe("utcDayKey", () => {
  it("derives the UTC calendar day", () => {
    expect(utcDayKey(0)).toBe("1970-01-01");
    expect(utcDayKey(1_700_000_000_000)).toBe("2023-11-14");
  });
});

describe("DailyRolloverScheduler", () => {
  it("does not roll over within the same UTC day", () => {
    let now = 1_700_000_000_000;
    const engine = new StrategyEngine({
      strategy: DEFAULT_STRATEGY_CONFIG,
      risk: DEFAULT_RISK_CONFIG,
      mode: "PAPER",
    });
    const before = engine.getRiskState().tradesToday;
    const scheduler = new DailyRolloverScheduler({ engine, now: () => now });
    scheduler.start();
    now += 60 * 60 * 1000;
    scheduler.tick();
    expect(engine.getRiskState().tradesToday).toBe(before);
    scheduler.stop();
  });

  it("rolls the engine over when the UTC day changes", () => {
    let now = 1_700_000_000_000;
    const engine = new StrategyEngine({
      strategy: DEFAULT_STRATEGY_CONFIG,
      risk: DEFAULT_RISK_CONFIG,
      mode: "PAPER",
      startingEquity: 10000,
    });
    const risk = engine.getRiskState();
    expect(risk.tradesToday).toBe(0);

    const scheduler = new DailyRolloverScheduler({ engine, now: () => now });
    scheduler.start();
    expect(scheduler.dayKey).toBe(utcDayKey(now));

    // Jump past midnight (UTC).
    now = now + 24 * 60 * 60 * 1000;
    expect(utcDayKey(now)).not.toBe(scheduler.dayKey);
    scheduler.tick();
    expect(scheduler.dayKey).toBe(utcDayKey(now));

    const events = engine.getActivity().getAll();
    expect(events.some((e) => e.detail.includes("rolled over"))).toBe(true);
    scheduler.stop();
  });

  it("ignores duplicate day keys on repeated ticks", () => {
    let now = 1_700_000_000_000;
    const engine = new StrategyEngine({
      strategy: DEFAULT_STRATEGY_CONFIG,
      risk: DEFAULT_RISK_CONFIG,
      mode: "PAPER",
    });
    const scheduler = new DailyRolloverScheduler({ engine, now: () => now });
    scheduler.start();
    scheduler.tick();
    scheduler.tick();
    const events = engine.getActivity().getAll();
    expect(events.filter((e) => e.detail.includes("rolled over")).length).toBe(0);
    scheduler.stop();
  });
});

describe("PollingFeedService", () => {
  it("backfills closed candles and feeds them to the engine", async () => {
    const timeframes: Timeframe[] = ["15M", "4H"];
    const dur15 = 15 * 60 * 1000;
    const candles: Record<string, Candle[]> = {};
    for (const tf of timeframes) {
      const dur = tf === "15M" ? dur15 : 4 * 60 * 60 * 1000;
      candles[tf] = [];
      for (let i = 0; i < 6; i++) {
        const ts = 1_700_000_000_000 + i * dur;
        candles[tf].push(mkCandle(ts, tf, 100 + i));
      }
    }

    let now = 1_700_000_000_000 + 6 * dur15;
    const engine = new StrategyEngine({
      strategy: DEFAULT_STRATEGY_CONFIG,
      risk: DEFAULT_RISK_CONFIG,
      mode: "PAPER",
    });

    const feed = new PollingFeedService({
      engine,
      marketData: {
        name: "test",
        getOHLCV: async (_sym, tf, start, end) =>
          candles[tf].filter((c) => c.timestamp >= start && c.timestamp <= end),
        getTicker: async () => ({ price: 100 }),
        getMarkets: async () => ["BTCUSDT"],
      },
      symbol: "BTCUSDT",
      timeframes,
      now: () => now,
      intervalMs: 1000,
      historyLimit: 10,
    });

    await feed.start();
    const stats = feed.getStats();
    expect(stats.running).toBe(true);
    expect(stats.candlesFed).toBeGreaterThan(0);
    // LTF history should be visible to the analysis engine.
    expect(engine.analysis.candlesFor("15M").length).toBeGreaterThan(0);
    feed.stop();
  });

  it("only feeds candles that have closed", async () => {
    const dur15 = 15 * 60 * 1000;
    const candles: Candle[] = [
      mkCandle(1_700_000_000_000, "15M", 100),
      mkCandle(1_700_000_000_000 + dur15, "15M", 101),
    ];
    // "now" is inside the second candle: only the first is closed.
    let now = 1_700_000_000_000 + dur15 + 60_000;
    const engine = new StrategyEngine({
      strategy: DEFAULT_STRATEGY_CONFIG,
      risk: DEFAULT_RISK_CONFIG,
      mode: "PAPER",
    });
    const feed = new PollingFeedService({
      engine,
      marketData: {
        name: "test",
        getOHLCV: async () => candles,
        getTicker: async () => ({ price: 101 }),
        getMarkets: async () => ["BTCUSDT"],
      },
      symbol: "BTCUSDT",
      timeframes: ["15M"],
      now: () => now,
      intervalMs: 1000,
      historyLimit: 10,
    });
    await feed.backfill();
    expect(engine.analysis.candlesFor("15M").length).toBe(1);

    // Once the second candle closes it is picked up on the next poll.
    now = 1_700_000_000_000 + 2 * dur15;
    await feed.poll();
    expect(engine.analysis.candlesFor("15M").length).toBe(2);
    feed.stop();
  });

  it("enters safe mode after consecutive feed failures (failsafe)", async () => {
    const reasons: string[] = [];
    const engine = new StrategyEngine({
      strategy: DEFAULT_STRATEGY_CONFIG,
      risk: DEFAULT_RISK_CONFIG,
      mode: "PAPER",
      startingEquity: 10000,
    });
    let fail = true;
    // Mirror ApiApp wiring: the feed's safe-mode hook enters safe mode on the engine.
    const feed = new PollingFeedService({
      engine,
      marketData: {
        name: "test",
        getOHLCV: async () => {
          if (fail) throw new Error("feed down");
          return [];
        },
        getTicker: async () => ({ price: 100 }),
        getMarkets: async () => ["BTCUSDT"],
      },
      symbol: "BTCUSDT",
      timeframes: ["15M"],
      now: () => 1_700_000_000_000,
      intervalMs: 1000,
      historyLimit: 10,
      safeModeThreshold: 2,
      onSafeMode: (r) => {
        reasons.push(r);
        engine.enterSafeMode(r);
      },
    });

    // A single failure must not yet trip safe mode.
    await expect(feed.poll()).rejects.toThrow("feed down");
    expect(engine.isSafetyBlocked()).toBe(false);
    expect(feed.getStats().consecutiveErrors).toBe(1);

    // Second consecutive failure crosses the threshold and triggers safe mode once.
    await expect(feed.poll()).rejects.toThrow("feed down");
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain("SAFE MODE");
    expect(engine.isSafetyBlocked()).toBe(true);
    expect(feed.getStats().consecutiveErrors).toBe(2);
    expect(feed.getStats().safeModeTriggered).toBe(true);
    expect(feed.getStats().lastError).toContain("feed down");

    // Repeated failures do not re-trigger the hook.
    await expect(feed.poll()).rejects.toThrow("feed down");
    expect(reasons.length).toBe(1);
    engine.exitSafeMode();
  });

  it("resets the failure streak on recovery but requires intervention to re-enable trading", async () => {
    const reasons: string[] = [];
    const engine = new StrategyEngine({
      strategy: DEFAULT_STRATEGY_CONFIG,
      risk: DEFAULT_RISK_CONFIG,
      mode: "PAPER",
      startingEquity: 10000,
    });
    let fail = true;
    const feed = new PollingFeedService({
      engine,
      marketData: {
        name: "test",
        getOHLCV: async () => {
          if (fail) throw new Error("feed down");
          return [];
        },
        getTicker: async () => ({ price: 100 }),
        getMarkets: async () => ["BTCUSDT"],
      },
      symbol: "BTCUSDT",
      timeframes: ["15M"],
      now: () => 1_700_000_000_000,
      intervalMs: 1000,
      historyLimit: 10,
      safeModeThreshold: 2,
      onSafeMode: (r) => engine.enterSafeMode(r),
    });

    await expect(feed.poll()).rejects.toThrow();
    await expect(feed.poll()).rejects.toThrow();
    expect(engine.isSafetyBlocked()).toBe(true);

    // Feed recovers, but the system must NOT auto-re-enable trading (§68).
    fail = false;
    await feed.poll();
    expect(feed.getStats().consecutiveErrors).toBe(0);
    expect(feed.getStats().safeModeTriggered).toBe(false);
    expect(feed.getStats().lastError).toBeNull();
    expect(engine.isSafetyBlocked()).toBe(true);
  });
});
