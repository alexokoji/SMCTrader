import type { Direction } from "../types/candles.js";
import type {
  PositionSizingResult,
  RiskDecision,
  RiskLimitKind,
  RiskLimitState,
  RiskRejection,
  RiskState,
} from "../types/risk.js";
import type { RiskConfig } from "../config/index.js";
import { round } from "../util.js";

export interface SizingInput {
  entry: number;
  stopLoss: number;
  riskPct: number;
  accountEquity: number;
  leverage: number;
  minQuantity?: number;
  stepSize?: number;
}

export function computePositionSize(input: SizingInput): PositionSizingResult {
  const slDistance = Math.abs(input.entry - input.stopLoss);
  const riskAmount = (input.accountEquity * input.riskPct) / 100;
  const warnings: string[] = [];
  let positionSize = slDistance > 0 ? riskAmount / slDistance : 0;
  if (input.minQuantity !== undefined && positionSize < input.minQuantity) {
    warnings.push(`Calculated quantity ${positionSize.toFixed(8)} is below the minimum ${input.minQuantity}.`);
  }
  if (input.stepSize !== undefined && input.stepSize > 0) {
    positionSize = Math.floor(positionSize / input.stepSize) * input.stepSize;
  }
  const notional = positionSize * input.entry;
  const margin = input.leverage > 0 ? notional / input.leverage : notional;
  return {
    riskPct: input.riskPct,
    accountEquity: input.accountEquity,
    riskAmount,
    entry: input.entry,
    stopLoss: input.stopLoss,
    slDistance,
    positionSize,
    notional,
    margin,
    leverageUsed: margin > 0 ? notional / margin : 0,
    minQuantity: input.minQuantity,
    stepSize: input.stepSize,
    warnings,
  };
}

export function checkRr(entry: number, stopLoss: number, tp: number, minRr: number): number {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(tp - entry);
  if (risk <= 0) return 0;
  return reward / risk;
}

export class RiskEngine {
  private cfg: RiskConfig;
  private state: RiskState;

  constructor(cfg: RiskConfig, initialState: Partial<RiskState> = {}) {
    this.cfg = cfg;
    this.state = {
      symbol: "",
      exchange: "",
      equity: initialState.equity ?? 10000,
      equityDayStart: initialState.equityDayStart ?? initialState.equity ?? 10000,
      peakEquity: initialState.peakEquity ?? initialState.equity ?? 10000,
      tradesToday: initialState.tradesToday ?? 0,
      realizedPnlToday: initialState.realizedPnlToday ?? 0,
      openPositions: initialState.openPositions ?? [],
      usedExposure: initialState.usedExposure ?? 0,
      usedCorrelatedExposure: initialState.usedCorrelatedExposure ?? 0,
      dailyLossReached: initialState.dailyLossReached ?? false,
      drawdownReached: initialState.drawdownReached ?? false,
    };
  }

  getState(): RiskState {
    return { ...this.state };
  }

  setEquity(equity: number): void {
    this.state.equity = equity;
    if (equity > this.state.peakEquity) this.state.peakEquity = equity;
  }

  onTradeExecuted(notional: number, correlationGroup: string): void {
    this.state.tradesToday += 1;
    this.state.usedExposure += notional;
    if (correlationGroup) this.state.usedCorrelatedExposure += notional;
  }

  onPositionClosed(pnl: number, notional: number, correlationGroup: string): void {
    this.state.realizedPnlToday += pnl;
    this.state.equity += pnl;
    this.state.usedExposure = Math.max(0, this.state.usedExposure - notional);
    if (correlationGroup) {
      this.state.usedCorrelatedExposure = Math.max(0, this.state.usedCorrelatedExposure - notional);
    }
    this.refreshLimits();
  }

  /** Refresh daily-loss / drawdown flags from current equity. */
  refreshLimits(): void {
    const dayStart = this.state.equityDayStart;
    const drawdownFromPeak = dayStart > 0 ? (this.state.peakEquity - this.state.equity) / this.state.peakEquity : 0;
    this.state.drawdownReached = drawdownFromPeak * 100 >= this.cfg.maxDrawdownPct;
    const dailyLoss = dayStart > 0 ? (dayStart - this.state.equity) / dayStart : 0;
    this.state.dailyLossReached = dailyLoss * 100 >= this.cfg.maxDailyLossPct;
  }

  /**
   * Roll over to a new trading day: rebase daily equity, reset daily trade
   * counters and clear the daily-loss flag. Peak equity and drawdown tracking
   * are preserved across the rollover.
   */
  rolloverDay(): void {
    this.state.equityDayStart = this.state.equity;
    this.state.tradesToday = 0;
    this.state.realizedPnlToday = 0;
    this.state.dailyLossReached = false;
    this.refreshLimits();
  }

  /**
   * Decide whether a proposed trade may proceed. The risk engine has the
   * authority to reject a strategy decision.
   */
  decide(input: {
    symbol: string;
    direction: Direction;
    entry: number;
    stopLoss: number;
    takeProfits: number[];
    minRr: number;
    leverage: number;
    minQuantity?: number;
    stepSize?: number;
    correlationGroup: string;
  }): RiskDecision {
    this.refreshLimits();
    const reasons: RiskRejection[] = [];
    const limits: RiskLimitState[] = [];
    const equity = this.state.equity;

    // 1. Daily trade limit (hard ceiling enforced elsewhere; here we check remaining)
    const remainingTrades = this.cfg.maxTradesPerDay - this.state.tradesToday;
    limits.push({
      kind: "DAILY_TRADE_LIMIT",
      limit: this.cfg.maxTradesPerDay,
      current: this.state.tradesToday,
      allowed: this.state.tradesToday < this.cfg.maxTradesPerDay,
      detail: `${this.state.tradesToday} of ${this.cfg.maxTradesPerDay} trades used today.`,
    });
    if (this.state.tradesToday >= this.cfg.maxTradesPerDay) {
      reasons.push({
        kind: "DAILY_TRADE_LIMIT",
        message: `Daily trade limit reached (${this.cfg.maxTradesPerDay}). This is a ceiling, not a target.`,
      });
    }

    // 2. Daily loss limit
    const dailyLossPct =
      this.state.equityDayStart > 0
        ? ((this.state.equityDayStart - this.state.equity) / this.state.equityDayStart) * 100
        : 0;
    limits.push({
      kind: "DAILY_LOSS_LIMIT",
      limit: this.cfg.maxDailyLossPct,
      current: round(dailyLossPct, 2),
      allowed: dailyLossPct < this.cfg.maxDailyLossPct,
      detail: `Daily loss ${round(dailyLossPct, 2)}% / limit ${this.cfg.maxDailyLossPct}%.`,
    });
    if (dailyLossPct >= this.cfg.maxDailyLossPct) {
      reasons.push({
        kind: "DAILY_LOSS_LIMIT",
        message: `Daily loss limit reached (${round(dailyLossPct, 2)}%). No new positions until the limit resets.`,
      });
    }

    // 3. Max drawdown
    const ddPct =
      this.state.peakEquity > 0
        ? ((this.state.peakEquity - this.state.equity) / this.state.peakEquity) * 100
        : 0;
    limits.push({
      kind: "MAX_DRAWDOWN",
      limit: this.cfg.maxDrawdownPct,
      current: round(ddPct, 2),
      allowed: ddPct < this.cfg.maxDrawdownPct,
      detail: `Drawdown ${round(ddPct, 2)}% / limit ${this.cfg.maxDrawdownPct}%.`,
    });
    if (ddPct >= this.cfg.maxDrawdownPct) {
      reasons.push({
        kind: "MAX_DRAWDOWN",
        message: `Maximum drawdown reached (${round(ddPct, 2)}%). Auto trading halted until intervention.`,
      });
    }

    // 4. Max open positions
    limits.push({
      kind: "MAX_OPEN_POSITIONS",
      limit: this.cfg.maxOpenPositions,
      current: this.state.openPositions.length,
      allowed: this.state.openPositions.length < this.cfg.maxOpenPositions,
      detail: `${this.state.openPositions.length} of ${this.cfg.maxOpenPositions} positions open.`,
    });
    if (this.state.openPositions.length >= this.cfg.maxOpenPositions) {
      reasons.push({
        kind: "MAX_OPEN_POSITIONS",
        message: `Maximum open positions reached (${this.cfg.maxOpenPositions}).`,
      });
    }

    // 5. Exposure.
    //
    // Risk-based sizing and notional exposure limits pull against each other: a
    // structural stop 0.3% away needs roughly 333% of equity in notional to
    // risk 1%. Vetoing the trade would discard every setup with a tight stop,
    // which is most of them on a lower timeframe. Exposure limits exist to
    // bound exposure, so the size is reduced to fit and the trade risks
    // proportionally less than configured.
    const leverage = Math.min(input.leverage || this.cfg.maxLeverage, this.cfg.maxLeverage);
    const requested = computePositionSize({
      entry: input.entry,
      stopLoss: input.stopLoss,
      riskPct: this.cfg.riskPerTrade,
      accountEquity: equity,
      leverage,
      minQuantity: input.minQuantity,
      stepSize: input.stepSize,
    });

    const headroom = (limitPct: number, usedNotional: number) =>
      Math.max(0, (equity * limitPct) / 100 - usedNotional);
    const notionalCap = Math.min(
      headroom(this.cfg.maxSymbolExposurePct, 0),
      headroom(this.cfg.maxPortfolioExposurePct, this.state.usedExposure),
      headroom(this.cfg.maxCorrelatedExposurePct, this.state.usedCorrelatedExposure),
    );

    let sizing = requested;
    let sizeReducedTo: number | undefined;
    if (requested.notional > notionalCap) {
      const cappedRiskPct = requested.notional > 0
        ? (this.cfg.riskPerTrade * notionalCap) / requested.notional
        : 0;
      sizing = computePositionSize({
        entry: input.entry,
        stopLoss: input.stopLoss,
        riskPct: cappedRiskPct,
        accountEquity: equity,
        leverage,
        minQuantity: input.minQuantity,
        stepSize: input.stepSize,
      });
      sizeReducedTo = cappedRiskPct;
      sizing.warnings.push(
        `Position reduced to respect exposure limits: risking ${round(cappedRiskPct, 3)}% instead of ${this.cfg.riskPerTrade}%.`,
      );
    }

    // A reduced position that rounds away to nothing is not tradeable.
    if (sizing.positionSize <= 0 || (input.minQuantity !== undefined && sizing.positionSize < input.minQuantity)) {
      reasons.push({
        kind: "MAX_SYMBOL_EXPOSURE",
        message: sizeReducedTo !== undefined
          ? `Exposure limits leave room for only ${round(notionalCap, 2)} of notional, below the minimum tradeable size.`
          : `Calculated position size is below the minimum tradeable size.`,
      });
    }

    const symbolExposurePct = (sizing.notional / equity) * 100;
    limits.push({
      kind: "MAX_SYMBOL_EXPOSURE",
      limit: this.cfg.maxSymbolExposurePct,
      current: round(symbolExposurePct, 2),
      allowed: symbolExposurePct <= this.cfg.maxSymbolExposurePct,
      detail: `Symbol exposure ${round(symbolExposurePct, 2)}% / limit ${this.cfg.maxSymbolExposurePct}%.`,
    });
    if (symbolExposurePct > this.cfg.maxSymbolExposurePct) {
      reasons.push({
        kind: "MAX_SYMBOL_EXPOSURE",
        message: `Symbol exposure ${round(symbolExposurePct, 2)}% exceeds the limit of ${this.cfg.maxSymbolExposurePct}%.`,
      });
    }

    // 6. Portfolio exposure
    const totalExposurePct = ((this.state.usedExposure + sizing.notional) / equity) * 100;
    limits.push({
      kind: "MAX_PORTFOLIO_EXPOSURE",
      limit: this.cfg.maxPortfolioExposurePct,
      current: round(totalExposurePct, 2),
      allowed: totalExposurePct <= this.cfg.maxPortfolioExposurePct,
      detail: `Portfolio exposure ${round(totalExposurePct, 2)}% / limit ${this.cfg.maxPortfolioExposurePct}%.`,
    });
    if (totalExposurePct > this.cfg.maxPortfolioExposurePct) {
      reasons.push({
        kind: "MAX_PORTFOLIO_EXPOSURE",
        message: `Portfolio exposure ${round(totalExposurePct, 2)}% exceeds the limit of ${this.cfg.maxPortfolioExposurePct}%.`,
      });
    }

    // 7. Correlated exposure
    const group = input.correlationGroup || "uncorrelated";
    const correlatedPct = ((this.state.usedCorrelatedExposure + sizing.notional) / equity) * 100;
    limits.push({
      kind: "MAX_CORRELATED_EXPOSURE",
      limit: this.cfg.maxCorrelatedExposurePct,
      current: round(correlatedPct, 2),
      allowed: correlatedPct <= this.cfg.maxCorrelatedExposurePct,
      detail: `${group} correlated exposure ${round(correlatedPct, 2)}% / limit ${this.cfg.maxCorrelatedExposurePct}%.`,
    });
    if (correlatedPct > this.cfg.maxCorrelatedExposurePct) {
      reasons.push({
        kind: "MAX_CORRELATED_EXPOSURE",
        message: `${group} correlated exposure ${round(correlatedPct, 2)}% exceeds the limit of ${this.cfg.maxCorrelatedExposurePct}%.`,
      });
    }

    // 8. Leverage
    const levUsed = sizing.leverageUsed;
    limits.push({
      kind: "MAX_LEVERAGE",
      limit: this.cfg.maxLeverage,
      current: round(levUsed, 2),
      allowed: levUsed <= this.cfg.maxLeverage + 1e-9,
      detail: `Leverage ${round(levUsed, 2)}x / limit ${this.cfg.maxLeverage}x.`,
    });
    if (levUsed > this.cfg.maxLeverage) {
      reasons.push({
        kind: "MAX_LEVERAGE",
        message: `Position requires ${round(levUsed, 2)}x leverage, above the limit of ${this.cfg.maxLeverage}x.`,
      });
    }

    // 9. Minimum RR, judged on the furthest target the trade is aiming at.
    // Earlier targets are partial exits with their own lower threshold, so
    // testing TP1 here rejected trades that reach the minimum where they end.
    const finalTp = input.takeProfits.length
      ? input.takeProfits.reduce(
          (best, tp) => (Math.abs(tp - input.entry) > Math.abs(best - input.entry) ? tp : best),
          input.takeProfits[0],
        )
      : 0;
    const finalRr = checkRr(input.entry, input.stopLoss, finalTp, input.minRr);
    limits.push({
      kind: "MIN_RR",
      limit: input.minRr,
      current: round(finalRr, 2),
      allowed: finalRr >= input.minRr,
      detail: `Projected RR to final target 1:${round(finalRr, 2)} / minimum 1:${input.minRr}.`,
    });
    if (finalRr < input.minRr) {
      reasons.push({
        kind: "MIN_RR",
        message: `Projected RR to the final target 1:${round(finalRr, 2)} is below the configured minimum 1:${input.minRr}.`,
      });
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      limits,
      sizing,
    };
  }

  getRemainingTradesToday(): number {
    return Math.max(0, this.cfg.maxTradesPerDay - this.state.tradesToday);
  }
}
