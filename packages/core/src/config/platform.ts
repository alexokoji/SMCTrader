import type { Timeframe } from "../types/candles.js";

/**
 * Platform safety ceilings. Users may never configure a value beyond these.
 */
export const PLATFORM_LIMITS = {
  /** Absolute maximum trades per day (1-15). Enforced by the backend regardless of input. */
  maxTradesPerDay: 15,
  /** Minimum RR a trade must project. */
  minRr: 1,
  /** Risk per trade in percent of equity (0.1% .. 5%). */
  riskPerTradeMin: 0.1,
  riskPerTradeMax: 5,
  /** Daily loss limit in percent (0.5% .. 10%). */
  dailyLossMin: 0.5,
  dailyLossMax: 10,
  /** Max drawdown in percent (2% .. 50%). */
  maxDrawdownMin: 2,
  maxDrawdownMax: 50,
  /** Maximum leverage. */
  maxLeverage: 125,
  /** Maximum open positions. */
  maxOpenPositions: 25,
  /** Maximum portfolio exposure in percent of equity. */
  maxPortfolioExposureMax: 1000,
  /** Maximum symbol exposure in percent of equity. */
  maxSymbolExposureMax: 500,
  /** Maximum correlated-group directional exposure in percent of equity. */
  maxCorrelatedExposureMax: 400,
} as const;

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
