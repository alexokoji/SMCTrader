/**
 * Agent domain model.
 *
 * An agent is a funded, independently supervised trader: it owns an allocation
 * of capital, a set of markets, its own analysis engine and its own risk
 * limits. Agents do not share state, so one performing badly cannot spend
 * another's capital or trigger another's limits.
 */
import type { EntryModel } from "../types/setup.js";
import type { Timeframe } from "../types/candles.js";

export type AgentMode = "PAPER" | "LIVE";

export type AgentStatus =
  | "ACTIVE"
  | "PAUSED"
  | "STOPPED"
  /** Halted by the supervisor rather than by the operator. */
  | "SUPERVISOR_PAUSED";

export type SupervisorState = "HEALTHY" | "OBSERVING" | "TIGHTENING" | "PAUSED";

export interface AgentConfig {
  id: string;
  name: string;
  mode: AgentMode;
  /** Capital the agent is allowed to trade, in quote currency. */
  allocatedCapital: number;
  symbols: string[];
  timeframes: { htf: Timeframe; mtf: Timeframe; ltf: Timeframe };
  entryModels: EntryModel[];
  /** Baseline settings. The supervisor adjusts working values, never these. */
  baseline: {
    riskPerTrade: number;
    minRr: number;
    minScore: number;
  };
  /** Current working settings, which the supervisor may tighten. */
  working: {
    riskPerTrade: number;
    minRr: number;
    minScore: number;
  };
  /** Only trade when conditions match; empty means any conditions. */
  requiredRegimes: string[];
  maxOpenPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface AgentPerformance {
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  consecutiveLosses: number;
  /** Peak-to-trough decline as a percent of allocated capital. */
  drawdownPct: number;
  equity: number;
  openPositions: number;
}

export interface AgentAdjustment {
  field: "minRr" | "minScore" | "riskPerTrade";
  from: number;
  to: number;
  reason: string;
}

export interface SupervisorVerdict {
  state: SupervisorState;
  headline: string;
  observations: string[];
  adjustments: AgentAdjustment[];
}

export interface AgentSnapshot {
  config: AgentConfig;
  performance: AgentPerformance;
  supervisor: SupervisorVerdict;
  /** Most recent adjustments actually applied, newest first. */
  adjustmentHistory: (AgentAdjustment & { at: number })[];
}

/** Capital cannot be committed twice: allocations are checked against a total. */
export function availableCapital(total: number, agents: Pick<AgentConfig, "allocatedCapital" | "status">[]): number {
  const committed = agents
    .filter((a) => a.status !== "STOPPED")
    .reduce((sum, a) => sum + a.allocatedCapital, 0);
  return Math.max(0, total - committed);
}

export interface AllocationCheck {
  ok: boolean;
  reason?: string;
  available: number;
}

/**
 * Validate a proposed allocation against the funding actually available. In
 * live mode that is the exchange balance; in paper mode the operator names the
 * figure, so only the arithmetic is enforced.
 */
export function checkAllocation(
  requested: number,
  totalAvailable: number,
  existing: Pick<AgentConfig, "allocatedCapital" | "status">[],
  excludeAgentId?: string,
  allAgents?: AgentConfig[],
): AllocationCheck {
  const others = excludeAgentId && allAgents
    ? allAgents.filter((a) => a.id !== excludeAgentId)
    : existing;
  const available = availableCapital(totalAvailable, others);

  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, reason: "Allocated capital must be greater than zero.", available };
  }
  if (requested > available) {
    return {
      ok: false,
      reason: `Only ${available.toFixed(2)} is uncommitted; ${requested.toFixed(2)} was requested. Reduce the amount or free capital from another agent.`,
      available,
    };
  }
  return { ok: true, available };
}
