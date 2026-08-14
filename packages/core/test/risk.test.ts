import { describe, expect, it } from "vitest";
import { computePositionSize, checkRr, RiskEngine } from "../src/risk/risk-engine.js";
import { validateRiskConfig } from "../src/config/index.js";
import { PLATFORM_LIMITS } from "../src/config/platform.js";
import { testRiskConfig } from "./helpers.js";

describe("position sizing", () => {
  it("sizes by risk amount over stop distance", () => {
    const r = computePositionSize({
      entry: 100,
      stopLoss: 98,
      riskPct: 1,
      accountEquity: 10000,
      leverage: 10,
    });
    expect(r.riskAmount).toBe(100);
    expect(r.slDistance).toBe(2);
    expect(r.positionSize).toBe(50);
    expect(r.notional).toBe(5000);
    expect(r.margin).toBe(500);
    expect(r.leverageUsed).toBe(10);
  });

  it("respects step size rounding", () => {
    const r = computePositionSize({
      entry: 100,
      stopLoss: 98,
      riskPct: 1,
      accountEquity: 10000,
      leverage: 10,
      stepSize: 30,
    });
    expect(r.positionSize).toBe(30);
  });

  it("warns when below minimum quantity", () => {
    const r = computePositionSize({
      entry: 100,
      stopLoss: 99.999,
      riskPct: 1,
      accountEquity: 10000,
      leverage: 1,
      minQuantity: 1e6,
    });
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("returns zero size for a zero-risk distance", () => {
    const r = computePositionSize({
      entry: 100,
      stopLoss: 100,
      riskPct: 1,
      accountEquity: 10000,
      leverage: 1,
    });
    expect(r.positionSize).toBe(0);
  });
});

describe("RR calculation", () => {
  it("computes reward to risk", () => {
    expect(checkRr(100, 95, 115, 1)).toBe(3);
  });
  it("returns 0 for a zero-risk distance", () => {
    expect(checkRr(100, 100, 115, 1)).toBe(0);
  });
});

describe("risk engine limits", () => {
  function engine(state?: Partial<ConstructorParameters<typeof RiskEngine>[1]>) {
    return new RiskEngine(validateRiskConfig(testRiskConfig()), state);
  }

  const goodInput = {
    symbol: "BTCUSDT",
    direction: "LONG" as const,
    entry: 100,
    stopLoss: 98,
    takeProfits: [106, 110, 114],
    minRr: 1,
    leverage: 10,
    correlationGroup: "major",
  };

  it("allows a healthy trade", () => {
    const d = engine().decide(goodInput);
    expect(d.allowed).toBe(true);
  });

  it("rejects when the daily trade limit is reached", () => {
    const e = engine({ tradesToday: 10 });
    const d = e.decide(goodInput);
    expect(d.allowed).toBe(false);
    expect(d.reasons[0].kind).toBe("DAILY_TRADE_LIMIT");
    expect(d.reasons[0].message).toContain("ceiling");
  });

  it("rejects when the daily loss limit is breached", () => {
    const e = engine({ equity: 9600, equityDayStart: 10000 });
    const d = e.decide(goodInput);
    expect(d.allowed).toBe(false);
    expect(d.reasons[0].kind).toBe("DAILY_LOSS_LIMIT");
  });

  it("rejects when the max drawdown is breached", () => {
    // day-start equity equals current equity so the daily-loss limit is not tripped
    const e = engine({ equity: 8500, equityDayStart: 8500, peakEquity: 10000 });
    const d = e.decide(goodInput);
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.kind === "MAX_DRAWDOWN")).toBe(true);
  });

  it("rejects when projected RR is below the minimum", () => {
    const d = engine().decide({ ...goodInput, takeProfits: [100.5], minRr: 2 });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.kind === "MIN_RR")).toBe(true);
  });

  it("tracks exposure and daily count on execution", () => {
    const e = engine();
    e.onTradeExecuted(5000, "major");
    expect(e.getState().tradesToday).toBe(1);
    expect(e.getState().usedExposure).toBe(5000);
    expect(e.getRemainingTradesToday()).toBe(9);
  });

  it("updates equity on close and refreshes limits", () => {
    const e = engine();
    e.onTradeExecuted(5000, "major");
    e.onPositionClosed(-500, 5000, "major");
    expect(e.getState().realizedPnlToday).toBe(-500);
    expect(e.getState().equity).toBe(9500);
    expect(e.getState().usedExposure).toBe(0);
    const d = e.decide(goodInput);
    // -5% > 3% daily loss limit
    expect(d.allowed).toBe(false);
  });

  it("clamps risk config to platform limits", () => {
    const cfg = validateRiskConfig(
      testRiskConfig({
        maxTradesPerDay: 99,
        riskPerTrade: 50,
        maxLeverage: 9999,
        maxOpenPositions: 999,
      }),
    );
    expect(cfg.maxTradesPerDay).toBe(PLATFORM_LIMITS.maxTradesPerDay);
    expect(cfg.riskPerTrade).toBe(PLATFORM_LIMITS.riskPerTradeMax);
    expect(cfg.maxLeverage).toBe(PLATFORM_LIMITS.maxLeverage);
    expect(cfg.maxOpenPositions).toBe(PLATFORM_LIMITS.maxOpenPositions);
  });
});
