import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/risk-engine.js";
import { testRiskConfig } from "./helpers.js";

/**
 * Risk-based sizing and notional exposure limits pull against each other. A
 * structural stop 0.3% away needs roughly 333% of equity in notional to risk
 * 1%, so vetoing on exposure discarded essentially every lower-timeframe setup.
 * Exposure limits bound exposure, so the size is reduced to fit instead.
 */
function engine(overrides = {}) {
  return new RiskEngine(testRiskConfig({ riskPerTrade: 1, maxSymbolExposurePct: 50, ...overrides }), {
    equity: 10_000,
    equityDayStart: 10_000,
    peakEquity: 10_000,
  });
}

/** Entry with a tight stop: 0.3% away, needing ~333% notional at 1% risk. */
const tightStop = {
  symbol: "BTCUSDT",
  direction: "LONG" as const,
  entry: 100,
  stopLoss: 99.7,
  takeProfits: [101, 101.5, 100.9],
  minRr: 3,
  leverage: 10,
  minQuantity: 0.0001,
  stepSize: 0.0001,
  correlationGroup: "major",
};

describe("exposure-capped position sizing", () => {
  it("trades a tight stop instead of vetoing it on exposure", () => {
    const decision = engine().decide(tightStop);
    expect(decision.allowed).toBe(true);
    expect(decision.sizing!.positionSize).toBeGreaterThan(0);
  });

  it("keeps notional inside the symbol exposure limit", () => {
    const decision = engine().decide(tightStop);
    const exposurePct = (decision.sizing!.notional / 10_000) * 100;
    expect(exposurePct).toBeLessThanOrEqual(50 + 1e-6);
  });

  it("risks proportionally less and says so", () => {
    const decision = engine().decide(tightStop);
    // Capped at 50% notional where 333% was wanted, so roughly 0.15% risk.
    expect(decision.sizing!.riskAmount).toBeLessThan(100);
    expect(decision.sizing!.warnings.join(" ")).toMatch(/reduced to respect exposure limits/);
  });

  it("leaves a wide stop untouched when it already fits", () => {
    const wide = { ...tightStop, stopLoss: 90, takeProfits: [130] };
    const decision = engine().decide(wide);
    expect(decision.allowed).toBe(true);
    // 1% risk over a 10% stop is 10% notional, well inside the limit.
    expect(decision.sizing!.warnings.join(" ")).not.toMatch(/reduced/);
    expect(decision.sizing!.riskAmount).toBeCloseTo(100, 6);
  });

  it("accounts for exposure already used by open positions", () => {
    const e = engine();
    e.onTradeExecuted(4_800, "major");
    const decision = e.decide(tightStop);
    const exposurePct = ((decision.sizing!.notional + 4_800) / 10_000) * 100;
    expect(exposurePct).toBeLessThanOrEqual(testRiskConfig().maxPortfolioExposurePct + 1e-6);
  });

  it("refuses when the remaining room is below the minimum tradeable size", () => {
    const decision = engine({ maxSymbolExposurePct: 0.00001 }).decide(tightStop);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((r) => r.message).join(" ")).toMatch(/minimum tradeable size/);
  });
});

describe("minimum reward-to-risk in the risk engine", () => {
  it("judges the furthest target, not the first", () => {
    // TP1 is 1:1, the final target is 1:3.
    const decision = engine().decide({
      ...tightStop,
      entry: 100,
      stopLoss: 99,
      takeProfits: [101, 103],
      minRr: 3,
    });
    expect(decision.reasons.map((r) => r.kind)).not.toContain("MIN_RR");
  });

  it("still refuses when even the furthest target falls short", () => {
    const decision = engine().decide({
      ...tightStop,
      entry: 100,
      stopLoss: 99,
      takeProfits: [100.5, 101.5],
      minRr: 3,
    });
    expect(decision.reasons.map((r) => r.kind)).toContain("MIN_RR");
    expect(decision.allowed).toBe(false);
  });
});
