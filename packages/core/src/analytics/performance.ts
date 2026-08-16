/**
 * Live performance analytics (§60).
 *
 * Closed positions are projected onto the same trade shape the backtester uses
 * so paper, live and historical results are measured by identical code. Nothing
 * here re-derives a trade outcome: it reports what the position manager already
 * recorded.
 */
import type { BacktestTrade } from "../backtest/engine.js";
import { computeStats, type BacktestStats, type EquityPoint } from "../backtest/stats.js";
import type { ManagedPosition } from "../execution/position-manager.js";
import type { Setup } from "../types/setup.js";

export interface SetupFunnel {
  /** Every setup the engine produced, whatever its outcome. */
  seen: number;
  valid: number;
  executed: number;
  rejected: number;
  /** Percentage of setups seen that reached execution. */
  executionRate: number;
}

export interface RejectionReason {
  reason: string;
  count: number;
}

export interface LivePerformance {
  stats: BacktestStats;
  funnel: SetupFunnel;
  /** Most frequent rejection reasons first — why the engine is not trading. */
  rejectionReasons: RejectionReason[];
  openPositions: number;
  closedPositions: number;
  startingEquity: number;
}

const REJECTED_STATUSES = new Set(["REJECTED", "INVALIDATED", "STALE"]);

/** When a position closed, preferring the recorded time over the last event. */
function closedAtOf(position: ManagedPosition): number {
  if (position.closedAt) return position.closedAt;
  const closeEvent = [...position.events].reverse().find((e) => e.type === "CLOSED");
  return closeEvent?.timestamp ?? position.openedAt;
}

/**
 * Realised reward-to-risk, measured against the distance from entry to the
 * original stop. Positions whose stop sat at the entry produce no meaningful
 * ratio and are reported as zero rather than as a division blow-up.
 */
function realisedRr(position: ManagedPosition): number {
  const riskPerUnit = Math.abs(position.entry - position.stopLoss);
  if (!Number.isFinite(riskPerUnit) || riskPerUnit === 0) return 0;
  const size = position.positionSize || 1;
  const pnl = position.finalPnl ?? position.realizedPnl;
  return pnl / (riskPerUnit * size);
}

/** Project closed positions onto the backtester's trade shape. */
export function positionsToTrades(positions: ManagedPosition[]): BacktestTrade[] {
  return positions
    .filter((position) => position.status === "CLOSED")
    .map((position) => {
      const closedAt = closedAtOf(position);
      return {
        setupId: position.setupId,
        symbol: position.symbol,
        direction: position.direction,
        entry: position.entry,
        exit: position.currentPrice,
        stopLoss: position.stopLoss,
        takeProfits: position.takeProfits,
        quantity: position.positionSize,
        pnl: position.finalPnl ?? position.realizedPnl,
        rr: realisedRr(position),
        score: 0,
        entryModel: position.entryModel ?? "UNSPECIFIED",
        openedAt: position.openedAt,
        closedAt,
        durationMs: Math.max(0, closedAt - position.openedAt),
        mae: position.mae,
        mfe: position.mfe,
        closeReason: position.closeReason ?? "CLOSED",
        strategyVersion: position.strategyVersion,
      } satisfies BacktestTrade;
    })
    .sort((a, b) => a.closedAt - b.closedAt);
}

/** Count how often each rejection reason blocked a setup, most frequent first. */
export function summariseRejections(setups: Setup[]): RejectionReason[] {
  const counts = new Map<string, number>();
  for (const setup of setups) {
    if (!REJECTED_STATUSES.has(setup.status)) continue;
    for (const reason of setup.rejectionReasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function computePerformance(input: {
  positions: ManagedPosition[];
  setups: Setup[];
  equityCurve: EquityPoint[];
  startingEquity: number;
}): LivePerformance {
  const trades = positionsToTrades(input.positions);
  const stats = computeStats(trades, input.equityCurve, input.startingEquity);

  const seen = input.setups.length;
  const executed = input.setups.filter((s) => s.status === "EXECUTED").length;
  const valid = input.setups.filter((s) => s.status === "VALID").length;
  const rejected = input.setups.filter((s) => REJECTED_STATUSES.has(s.status)).length;

  return {
    stats,
    funnel: {
      seen,
      valid,
      executed,
      rejected,
      executionRate: seen > 0 ? (executed / seen) * 100 : 0,
    },
    rejectionReasons: summariseRejections(input.setups),
    openPositions: input.positions.filter((p) => p.status === "OPEN").length,
    closedPositions: trades.length,
    startingEquity: input.startingEquity,
  };
}
