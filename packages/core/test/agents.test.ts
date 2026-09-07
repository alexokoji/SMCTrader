import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_BOUNDS,
  DEFAULT_SUPERVISOR_THRESHOLDS,
  relaxAgent,
  reviewAgent,
} from "../src/agents/supervisor.js";
import {
  availableCapital,
  checkAllocation,
  type AgentConfig,
  type AgentPerformance,
} from "../src/agents/types.js";
import { classifyRegime, directionalEfficiency, modelsSuitedTo } from "../src/agents/regime.js";
import type { Candle, Timeframe } from "../src/types/candles.js";

function perf(overrides: Partial<AgentPerformance> = {}): AgentPerformance {
  return {
    closedTrades: 20,
    wins: 12,
    losses: 8,
    winRate: 60,
    netPnl: 400,
    profitFactor: 1.8,
    consecutiveLosses: 1,
    drawdownPct: 2,
    equity: 10_400,
    openPositions: 0,
    ...overrides,
  };
}

const current = { minRr: 3, minScore: 60, riskPerTrade: 1 };

describe("supervisor", () => {
  it("waits for a meaningful sample before judging the analysis", () => {
    const verdict = reviewAgent(perf({ closedTrades: 4, winRate: 0, netPnl: -200 }), current);
    expect(verdict.state).toBe("OBSERVING");
    expect(verdict.adjustments).toEqual([]);
    expect(verdict.headline).toMatch(/4 of 10/);
  });

  it("pauses on drawdown immediately, without waiting for a sample", () => {
    const verdict = reviewAgent(perf({ closedTrades: 2, drawdownPct: 12 }), current);
    expect(verdict.state).toBe("PAUSED");
    expect(verdict.adjustments).toEqual([]);
    expect(verdict.headline).toMatch(/drawdown/i);
  });

  it("leaves a healthy agent alone", () => {
    const verdict = reviewAgent(perf(), current);
    expect(verdict.state).toBe("HEALTHY");
    expect(verdict.adjustments).toEqual([]);
  });

  it("tightens selectivity on a losing streak and says why", () => {
    const verdict = reviewAgent(perf({ consecutiveLosses: 5 }), current);
    expect(verdict.state).toBe("TIGHTENING");
    expect(verdict.observations.join(" ")).toMatch(/5 losses in a row/);
    const fields = verdict.adjustments.map((a) => a.field);
    expect(fields).toContain("minRr");
    expect(fields).toContain("minScore");
  });

  it("tightens harder when several measures deteriorate together", () => {
    const one = reviewAgent(perf({ consecutiveLosses: 5 }), current);
    const many = reviewAgent(
      perf({ consecutiveLosses: 5, winRate: 20, profitFactor: 0.5, netPnl: -300 }),
      current,
    );
    const rrOf = (v: typeof one) => v.adjustments.find((a) => a.field === "minRr")!.to;
    expect(rrOf(many)).toBeGreaterThan(rrOf(one));
  });

  it("only ever reduces risk, never raises it", () => {
    const verdict = reviewAgent(
      perf({ winRate: 10, profitFactor: 0.3, consecutiveLosses: 6, netPnl: -800 }),
      current,
    );
    const risk = verdict.adjustments.find((a) => a.field === "riskPerTrade");
    expect(risk!.to).toBeLessThan(current.riskPerTrade);
    expect(risk!.to).toBeGreaterThanOrEqual(ADJUSTMENT_BOUNDS.minRiskPct);
  });

  it("cannot tighten past its bounds however bad results get", () => {
    const verdict = reviewAgent(
      perf({ winRate: 0, profitFactor: 0, consecutiveLosses: 40, netPnl: -5_000 }),
      { minRr: 5.9, minScore: 84, riskPerTrade: 0.15 },
    );
    for (const adjustment of verdict.adjustments) {
      if (adjustment.field === "minRr") {
        expect(adjustment.to).toBeLessThanOrEqual(ADJUSTMENT_BOUNDS.maxMinRr);
      }
      if (adjustment.field === "minScore") {
        expect(adjustment.to).toBeLessThanOrEqual(ADJUSTMENT_BOUNDS.maxMinScore);
      }
      if (adjustment.field === "riskPerTrade") {
        expect(adjustment.to).toBeGreaterThanOrEqual(ADJUSTMENT_BOUNDS.minRiskPct);
      }
    }
  });

  it("releases constraints once results recover, never past the baseline", () => {
    const baseline = { minRr: 3, minScore: 60, riskPerTrade: 1 };
    const tightened = { minRr: 4.5, minScore: 75, riskPerTrade: 0.5 };
    const adjustments = relaxAgent(perf({ winRate: 62, netPnl: 900 }), tightened, baseline);

    expect(adjustments.length).toBeGreaterThan(0);
    for (const a of adjustments) {
      if (a.field === "minRr") expect(a.to).toBeGreaterThanOrEqual(baseline.minRr);
      if (a.field === "riskPerTrade") expect(a.to).toBeLessThanOrEqual(baseline.riskPerTrade);
    }
  });

  it("does not release constraints while results are still poor", () => {
    const baseline = { minRr: 3, minScore: 60, riskPerTrade: 1 };
    const tightened = { minRr: 4.5, minScore: 75, riskPerTrade: 0.5 };
    expect(relaxAgent(perf({ winRate: 30, netPnl: -100 }), tightened, baseline)).toEqual([]);
    expect(DEFAULT_SUPERVISOR_THRESHOLDS.healthyWinRate).toBeGreaterThan(
      DEFAULT_SUPERVISOR_THRESHOLDS.poorWinRate,
    );
  });
});

describe("capital allocation", () => {
  function agent(id: string, capital: number, status: AgentConfig["status"] = "ACTIVE"): AgentConfig {
    return { id, allocatedCapital: capital, status } as AgentConfig;
  }

  it("counts only capital that is still committed", () => {
    const agents = [agent("a", 3_000), agent("b", 2_000), agent("c", 5_000, "STOPPED")];
    expect(availableCapital(10_000, agents)).toBe(5_000);
  });

  it("refuses an allocation beyond what is uncommitted", () => {
    const check = checkAllocation(6_000, 10_000, [agent("a", 5_000)]);
    expect(check.ok).toBe(false);
    expect(check.available).toBe(5_000);
    expect(check.reason).toMatch(/uncommitted/);
  });

  it("accepts an allocation that fits exactly", () => {
    expect(checkAllocation(5_000, 10_000, [agent("a", 5_000)]).ok).toBe(true);
  });

  it("rejects a zero or negative allocation", () => {
    expect(checkAllocation(0, 10_000, []).ok).toBe(false);
    expect(checkAllocation(-100, 10_000, []).ok).toBe(false);
  });

  it("excludes the agent being edited from its own commitment", () => {
    const all = [agent("a", 5_000), agent("b", 2_000)];
    const check = checkAllocation(7_000, 10_000, [], "a", all);
    expect(check.ok).toBe(true);
  });
});

const HOUR = 3_600_000;

function candles(count: number, step: (i: number) => number, range = 50): Candle[] {
  let price = 30_000;
  return Array.from({ length: count }, (_, i) => {
    const open = price;
    const close = open + step(i);
    price = close;
    return {
      symbol: "BTCUSDT",
      exchange: "t",
      timeframe: "1H" as Timeframe,
      timestamp: i * HOUR,
      open,
      close,
      high: Math.max(open, close) + range,
      low: Math.min(open, close) - range,
      volume: 1,
    };
  });
}

describe("market regime", () => {
  it("scores a straight move as fully efficient", () => {
    expect(directionalEfficiency(candles(30, () => 100))).toBeCloseTo(1, 5);
  });

  it("scores an oscillation as inefficient", () => {
    expect(directionalEfficiency(candles(30, (i) => (i % 2 ? 100 : -100)))).toBeLessThan(0.2);
  });

  it("says so plainly when there is not enough history", () => {
    const reading = classifyRegime(candles(5, () => 10), "BULLISH");
    expect(reading.regime).toBe("UNKNOWN");
    expect(reading.detail).toMatch(/at least 20/);
  });

  it("identifies a trend that agrees with structure", () => {
    const reading = classifyRegime(candles(60, () => 120, 30), "BULLISH");
    expect(reading.regime).toBe("TRENDING_UP");
    expect(reading.efficiency).toBeGreaterThan(0.28);
  });

  it("identifies chop as ranging rather than trending", () => {
    const reading = classifyRegime(candles(60, (i) => (i % 2 ? 150 : -150), 30), "BULLISH");
    expect(reading.regime).toBe("RANGING");
  });

  it("flags conditions where structural stops become very wide", () => {
    const reading = classifyRegime(candles(60, (i) => (i % 2 ? 900 : -880), 1_400), "RANGING");
    expect(reading.regime).toBe("VOLATILE");
    expect(reading.volatilityPct).toBeGreaterThan(2.5);
  });

  it("recommends no entry model in conditions too quiet to cover costs", () => {
    expect(modelsSuitedTo("QUIET")).toEqual([]);
    expect(modelsSuitedTo("TRENDING_UP")).toContain("CONFIRMATION");
    expect(modelsSuitedTo("RANGING")).toEqual(["SWEEP"]);
  });
});
