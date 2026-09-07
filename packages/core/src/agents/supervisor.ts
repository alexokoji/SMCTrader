/**
 * Performance supervision.
 *
 * A separate concern from analysis on purpose: the analysis engine judges
 * setups, and this judges the analysis. When an agent's realised results
 * deteriorate, the supervisor tightens what that agent is allowed to take and
 * says why. When results recover, it releases the constraints again.
 *
 * Every adjustment is deterministic and bounded. The supervisor can make an
 * agent more selective or stop it; it can never make it riskier than the
 * configuration it was given.
 */
import type { AgentPerformance, AgentAdjustment, SupervisorVerdict } from "./types.js";

export interface SupervisorThresholds {
  /** Trades required before results are treated as meaningful. */
  minimumSample: number;
  /** Win rate below which the agent is tightened. */
  poorWinRate: number;
  /** Consecutive losses that trigger tightening on their own. */
  losingStreak: number;
  /** Drawdown percent of allocated capital that pauses the agent. */
  pauseDrawdownPct: number;
  /** Profit factor below which the agent is tightened. */
  poorProfitFactor: number;
  /**
   * Win rate above which constraints are released again. The framework's own
   * arithmetic is the reference: at a 1:3 minimum, a 40% win rate is enough to
   * stay profitable, so demanding more than that would leave a profitable agent
   * permanently throttled.
   */
  healthyWinRate: number;
}

export const DEFAULT_SUPERVISOR_THRESHOLDS: SupervisorThresholds = {
  minimumSample: 10,
  poorWinRate: 35,
  losingStreak: 4,
  pauseDrawdownPct: 10,
  poorProfitFactor: 0.9,
  healthyWinRate: 40,
};

/**
 * What is wrong with an agent's results, if anything. Shared by tightening and
 * relaxation so releasing constraints is the exact inverse of applying them.
 */
export function concernsFor(
  performance: AgentPerformance,
  thresholds: SupervisorThresholds = DEFAULT_SUPERVISOR_THRESHOLDS,
): string[] {
  const observations: string[] = [];

  if (performance.consecutiveLosses >= thresholds.losingStreak) {
    observations.push(
      `${performance.consecutiveLosses} losses in a row. The setups being accepted are not behaving as analysed.`,
    );
  }
  if (performance.winRate < thresholds.poorWinRate) {
    observations.push(
      `Win rate is ${performance.winRate.toFixed(1)}%, below the ${thresholds.poorWinRate}% the analysis needs to justify its reward-to-risk.`,
    );
  }
  if (Number.isFinite(performance.profitFactor) && performance.profitFactor < thresholds.poorProfitFactor) {
    observations.push(
      `Profit factor is ${performance.profitFactor.toFixed(2)}: losses are outweighing wins.`,
    );
  }
  return observations;
}

/** Bounds on how far the supervisor may move an agent's settings. */
export const ADJUSTMENT_BOUNDS = {
  maxMinRr: 6,
  maxMinScore: 85,
  minRiskPct: 0.1,
};

/**
 * Review an agent's realised performance and decide what, if anything, should
 * change. Returns the verdict and the adjustments to apply.
 */
export function reviewAgent(
  performance: AgentPerformance,
  current: { minRr: number; minScore: number; riskPerTrade: number },
  thresholds: SupervisorThresholds = DEFAULT_SUPERVISOR_THRESHOLDS,
): SupervisorVerdict {
  const adjustments: AgentAdjustment[] = [];
  const observations: string[] = [];

  // Drawdown is assessed immediately: it does not wait for a sample, because
  // capital lost is lost whether or not the sample is significant.
  if (performance.drawdownPct >= thresholds.pauseDrawdownPct) {
    return {
      state: "PAUSED",
      headline: `Paused after a ${performance.drawdownPct.toFixed(1)}% drawdown on allocated capital.`,
      observations: [
        `Drawdown reached ${performance.drawdownPct.toFixed(1)}%, at or beyond the ${thresholds.pauseDrawdownPct}% limit.`,
        "Trading is halted for this agent until it is resumed deliberately.",
      ],
      adjustments: [],
    };
  }

  if (performance.closedTrades < thresholds.minimumSample) {
    return {
      state: "OBSERVING",
      headline: `Gathering results: ${performance.closedTrades} of ${thresholds.minimumSample} trades needed before judging the analysis.`,
      observations: [
        "Too few closed trades to distinguish a bad approach from ordinary variance.",
      ],
      adjustments: [],
    };
  }

  const found = concernsFor(performance, thresholds);
  const concerns = found.length;
  observations.push(...found);

  if (concerns === 0) {
    const healthy = performance.winRate >= thresholds.healthyWinRate && performance.netPnl > 0;
    return {
      state: healthy ? "HEALTHY" : "OBSERVING",
      headline: healthy
        ? `Performing as analysed: ${performance.winRate.toFixed(1)}% win rate over ${performance.closedTrades} trades.`
        : `Within tolerance over ${performance.closedTrades} trades. No change required.`,
      observations: observations.length ? observations : ["Results are consistent with the analysis."],
      adjustments: [],
    };
  }

  // Each concern tightens selectivity by one step. Raising the required
  // reward-to-risk and setup score makes the agent take fewer, better setups;
  // reducing risk limits the cost of continuing to be wrong.
  const nextMinRr = Math.min(ADJUSTMENT_BOUNDS.maxMinRr, round1(current.minRr + 0.5 * concerns));
  const nextMinScore = Math.min(ADJUSTMENT_BOUNDS.maxMinScore, Math.round(current.minScore + 5 * concerns));
  const nextRisk = Math.max(ADJUSTMENT_BOUNDS.minRiskPct, round2(current.riskPerTrade * (concerns >= 2 ? 0.5 : 0.75)));

  if (nextMinRr > current.minRr) {
    adjustments.push({
      field: "minRr",
      from: current.minRr,
      to: nextMinRr,
      reason: "Demand more reward for the same risk before accepting a setup.",
    });
  }
  if (nextMinScore > current.minScore) {
    adjustments.push({
      field: "minScore",
      from: current.minScore,
      to: nextMinScore,
      reason: "Accept only higher-quality setups until results recover.",
    });
  }
  if (nextRisk < current.riskPerTrade) {
    adjustments.push({
      field: "riskPerTrade",
      from: current.riskPerTrade,
      to: nextRisk,
      reason: "Reduce the cost of each trade while the analysis is underperforming.",
    });
  }

  return {
    state: "TIGHTENING",
    headline: `${concerns} performance ${concerns === 1 ? "concern" : "concerns"} found. The agent is being made more selective.`,
    observations,
    adjustments,
  };
}

/**
 * Release constraints one step at a time once results recover, so an agent that
 * was tightened does not stay permanently restricted.
 */
export function relaxAgent(
  performance: AgentPerformance,
  current: { minRr: number; minScore: number; riskPerTrade: number },
  baseline: { minRr: number; minScore: number; riskPerTrade: number },
  thresholds: SupervisorThresholds = DEFAULT_SUPERVISOR_THRESHOLDS,
): AgentAdjustment[] {
  if (performance.closedTrades < thresholds.minimumSample) return [];
  // Release constraints when the agent is making money and nothing is currently
  // wrong. Requiring a win rate the strategy does not need to be profitable
  // left a profitable agent tightened permanently.
  if (performance.netPnl <= 0) return [];
  if (concernsFor(performance, thresholds).length > 0) return [];

  const adjustments: AgentAdjustment[] = [];
  if (current.minRr > baseline.minRr) {
    adjustments.push({
      field: "minRr",
      from: current.minRr,
      to: round1(Math.max(baseline.minRr, current.minRr - 0.5)),
      reason: "Results recovered; returning towards the configured reward-to-risk.",
    });
  }
  if (current.minScore > baseline.minScore) {
    adjustments.push({
      field: "minScore",
      from: current.minScore,
      to: Math.max(baseline.minScore, current.minScore - 5),
      reason: "Results recovered; widening the quality filter back towards its baseline.",
    });
  }
  if (current.riskPerTrade < baseline.riskPerTrade) {
    adjustments.push({
      field: "riskPerTrade",
      from: current.riskPerTrade,
      to: round2(Math.min(baseline.riskPerTrade, current.riskPerTrade * 1.5)),
      reason: "Results recovered; restoring risk towards the configured level.",
    });
  }
  return adjustments;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
