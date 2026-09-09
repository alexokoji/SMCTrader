import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_CONFIG, RiskEngine } from "../src/index.js";
import { StrategyEngine, dayKeyOf } from "../src/strategy/strategy-engine.js";
import { DEFAULT_STRATEGY_CONFIG } from "../src/config/index.js";

/**
 * A limit that never clears is not a limit, it is a stop. Every lockout the
 * risk engine can reach is asserted here to release on a new trading day,
 * because each one of them silently retired a working agent in production.
 */

const DAY = 24 * 60 * 60 * 1000;

function engineAt(startingEquity = 10_000): StrategyEngine {
  return new StrategyEngine({
    strategy: { ...DEFAULT_STRATEGY_CONFIG, symbol: "BTCUSDT" },
    risk: { ...DEFAULT_RISK_CONFIG },
    mode: "PAPER",
    startingEquity,
  });
}

describe("risk engine daily rollover", () => {
  it("clears the trade counter", () => {
    const risk = new RiskEngine(DEFAULT_RISK_CONFIG, { equity: 10_000 });
    for (let i = 0; i < DEFAULT_RISK_CONFIG.maxTradesPerDay; i++) risk.onTradeExecuted(100, "");
    expect(risk.getRemainingTradesToday()).toBe(0);

    risk.rolloverDay();
    expect(risk.getState().tradesToday).toBe(0);
    expect(risk.getRemainingTradesToday()).toBe(DEFAULT_RISK_CONFIG.maxTradesPerDay);
  });

  it("clears a daily-loss lockout and rebases the reference equity", () => {
    const risk = new RiskEngine(DEFAULT_RISK_CONFIG, { equity: 10_000 });
    risk.onPositionClosed(-10_000 * (DEFAULT_RISK_CONFIG.maxDailyLossPct / 100) - 1, 0, "");
    expect(risk.getState().dailyLossReached).toBe(true);

    risk.rolloverDay();
    const state = risk.getState();
    expect(state.dailyLossReached).toBe(false);
    // Tomorrow's loss is measured from tonight's equity, not from the original
    // balance, or yesterday's loss would keep the lockout on forever.
    expect(state.equityDayStart).toBeCloseTo(state.equity, 6);
  });

  it("clears a drawdown lockout, which equity alone could never recover from", () => {
    const risk = new RiskEngine(DEFAULT_RISK_CONFIG, { equity: 10_000 });
    risk.onPositionClosed(-10_000 * (DEFAULT_RISK_CONFIG.maxDrawdownPct / 100) - 1, 0, "");
    expect(risk.getState().drawdownReached).toBe(true);

    risk.rolloverDay();
    expect(risk.getState().drawdownReached).toBe(false);
    expect(risk.getState().peakEquity).toBeCloseTo(risk.getState().equity, 6);
  });
});

describe("strategy engine day boundary", () => {
  const monday = Date.parse("2026-09-07T12:00:00Z");

  it("does not roll a fresh engine over, and reports today", () => {
    const engine = engineAt();
    expect(engine.rolloverIfNewDay(monday)).toBe(false);
    expect(engine.serialize().dailyCounter.dayKey).toBe("2026-09-07");
  });

  it("does not roll over twice within the same UTC day", () => {
    const engine = engineAt();
    engine.rolloverIfNewDay(monday);
    expect(engine.rolloverIfNewDay(monday + 6 * 60 * 60 * 1000)).toBe(false);
  });

  it("rolls over once the UTC day advances, releasing the trade ceiling", () => {
    const engine = engineAt();
    engine.rolloverIfNewDay(monday);

    const snapshot = engine.serialize();
    snapshot.risk.tradesToday = DEFAULT_RISK_CONFIG.maxTradesPerDay;
    snapshot.risk.dailyLossReached = true;
    engine.restore(snapshot);

    expect(engine.rolloverIfNewDay(monday + DAY)).toBe(true);
    const after = engine.serialize();
    expect(after.risk.tradesToday).toBe(0);
    expect(after.risk.dailyLossReached).toBe(false);
    expect(after.dailyCounter).toEqual({ dayKey: "2026-09-08", count: 0 });
  });

  it("clears counters carried by a snapshot written before day keys existed", () => {
    // Exactly the production state this fixes: counters that accumulated for
    // weeks because nothing ever advanced the day.
    const engine = engineAt();
    const snapshot = engine.serialize();
    snapshot.dailyCounter = { dayKey: "", count: 0 };
    snapshot.risk.tradesToday = 54;
    engine.restore(snapshot);

    expect(engine.rolloverIfNewDay(monday)).toBe(true);
    expect(engine.serialize().risk.tradesToday).toBe(0);
  });

  it("adopts today without a rollover when an old snapshot had used no trades", () => {
    const engine = engineAt();
    const snapshot = engine.serialize();
    snapshot.dailyCounter = { dayKey: "", count: 0 };
    engine.restore(snapshot);

    expect(engine.rolloverIfNewDay(monday)).toBe(false);
    expect(engine.serialize().dailyCounter.dayKey).toBe("2026-09-07");
  });
});

describe("dayKeyOf", () => {
  it("names the UTC day, not the local one", () => {
    expect(dayKeyOf(Date.parse("2026-09-07T23:59:59Z"))).toBe("2026-09-07");
    expect(dayKeyOf(Date.parse("2026-09-08T00:00:01Z"))).toBe("2026-09-08");
  });
});
