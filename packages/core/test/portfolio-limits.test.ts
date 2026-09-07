import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/risk-engine.js";
import { testRiskConfig } from "./helpers.js";
import type { PortfolioPosition } from "../src/types/risk.js";

/**
 * Limits such as maximum open positions describe an account, not one market.
 * An agent runs one engine per market, so each engine has to be told what the
 * others hold: without that an agent with ten markets could hold ten times its
 * configured maximum.
 */
function position(symbol: string, notional = 500): PortfolioPosition {
  return {
    id: `POS-${symbol}`,
    symbol,
    exchange: "test",
    direction: "LONG",
    setupId: "s",
    strategyVersion: "v1",
    entry: 100,
    positionSize: notional / 100,
    notional,
    stopLoss: 95,
    takeProfits: [110],
    partialPlan: [],
    currentPrice: 100,
    unrealizedPnl: 0,
    openedAt: 1,
  };
}

function engine(overrides = {}, own: PortfolioPosition[] = []) {
  return new RiskEngine(testRiskConfig({ maxOpenPositions: 3, ...overrides }), {
    equity: 10_000,
    equityDayStart: 10_000,
    peakEquity: 10_000,
    openPositions: own,
  });
}

const request = {
  symbol: "BTCUSDT",
  direction: "LONG" as const,
  entry: 100,
  stopLoss: 90,
  takeProfits: [130],
  minRr: 3,
  leverage: 5,
  minQuantity: 0.0001,
  stepSize: 0.0001,
  correlationGroup: "major",
};

describe("maximum open positions across a portfolio", () => {
  it("counts positions held on other markets toward the limit", () => {
    const risk = engine({}, [position("BTCUSDT")]);
    risk.setPortfolioContext({ openPositions: 2 });

    const decision = risk.decide(request);
    // One here plus two elsewhere is the configured maximum of three.
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((r) => r.kind)).toContain("MAX_OPEN_POSITIONS");
  });

  it("says the limit applies across all markets, not just this one", () => {
    const risk = engine({}, []);
    risk.setPortfolioContext({ openPositions: 3 });
    const decision = risk.decide(request);
    expect(decision.reasons.find((r) => r.kind === "MAX_OPEN_POSITIONS")?.message)
      .toMatch(/across all markets/);
  });

  it("still allows a trade while the portfolio is inside the limit", () => {
    const risk = engine({}, []);
    risk.setPortfolioContext({ openPositions: 2 });
    expect(risk.decide(request).allowed).toBe(true);
  });

  it("behaves as before when nothing is held elsewhere", () => {
    const risk = engine({}, [position("BTCUSDT"), position("BTCUSDT2")]);
    expect(risk.decide(request).allowed).toBe(true);
  });

  it("counts exposure held elsewhere against the portfolio limit", () => {
    // A stop 1% away needs 10,000 of notional to risk 1%, so the exposure
    // allowance binds rather than the risk calculation.
    const tight = { ...request, stopLoss: 99, takeProfits: [103] };
    const risk = engine({ maxPortfolioExposurePct: 100, maxSymbolExposurePct: 100 });
    const withoutContext = risk.decide(tight).sizing!.notional;
    expect(withoutContext).toBeCloseTo(10_000, 0);

    risk.setPortfolioContext({ exposure: 9_000 });
    const withContext = risk.decide(tight).sizing!.notional;

    // Only 1,000 of the 10,000 portfolio allowance is left.
    expect(withContext).toBeLessThan(withoutContext);
    expect(withContext).toBeLessThanOrEqual(1_000 + 1e-6);
  });

  it("counts correlated exposure held elsewhere", () => {
    const tight = { ...request, stopLoss: 99, takeProfits: [103] };
    const risk = engine({ maxCorrelatedExposurePct: 50, maxSymbolExposurePct: 100, maxPortfolioExposurePct: 200 });
    risk.setPortfolioContext({ correlatedExposure: 4_900 });
    const decision = risk.decide(tight);
    // 50% of 10,000 is 5,000; 4,900 is already used elsewhere.
    expect(decision.sizing!.notional).toBeLessThanOrEqual(100 + 1e-6);
  });

  it("treats a negative or missing context as nothing held elsewhere", () => {
    const risk = engine({}, []);
    risk.setPortfolioContext({ openPositions: -5, exposure: -100 });
    expect(risk.getPortfolioContext()).toEqual({
      openPositions: 0,
      exposure: 0,
      correlatedExposure: 0,
    });
    expect(risk.decide(request).allowed).toBe(true);
  });
});
