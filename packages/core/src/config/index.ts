import type { Timeframe } from "../types/candles.js";
import type { EntryModel } from "../types/setup.js";
import type { PartialClosePlanItem } from "../types/risk.js";
import { PLATFORM_LIMITS, clamp } from "./platform.js";

export interface EntryModelsConfig {
  aggressive: boolean;
  confirmation: boolean;
  sweep: boolean;
  counterTrend: boolean;
}

export type { PartialClosePlanItem };

export interface StrategyConfig {
  version: string;
  name: string;
  symbol: string;
  exchange: string;
  timeframes: { htf: Timeframe; mtf: Timeframe; ltf: Timeframe };
  entryModels: EntryModelsConfig;
  /** minimum projected RR for a trade to be eligible (1:minRr) */
  minRr: number;
  /** minimum RR for TP1 */
  tp1MinRr: number;
  /** swing detection strength (bars each side) */
  swingStrength: number;
  /** candles of lookback for structure detection */
  structureLookback: number;
  /** displacement threshold in ATR multiples */
  displacementAtrMultiple: number;
  /** ATR period */
  atrPeriod: number;
  /** tolerance for equal highs/lows (fraction of ATR) */
  equalLevelToleranceAtr: number;
  /** stale setup lifetime in ms */
  setupMaxAgeMs: number;
  /** max distance from POI entry tolerance (fraction of range) */
  entryTolerancePct: number;
  /** enable inducement detection (contextual only) */
  inducementEnabled: boolean;
  /** enable premium/discount confluence */
  premiumDiscountEnabled: boolean;
  /** require price to be in discount for longs, premium for shorts */
  requirePremiumDiscount: boolean;
  /** swing points (fractal) bars required for significant structure */
  significantSwings: number;
  /** partial close plan, e.g. TP1 close 50%, TP2 close 25% */
  partialClosePlan: PartialClosePlanItem[];
  /** break-even on TP1 */
  breakEvenOnTp1: boolean;
  /** counter-trend max RR requirement multiplier */
  counterTrendMinRrMultiplier: number;
}

export interface RiskConfig {
  /** risk per trade in percent of equity */
  riskPerTrade: number;
  /** daily loss limit in percent of day-start equity */
  maxDailyLossPct: number;
  /** max drawdown in percent of peak equity */
  maxDrawdownPct: number;
  /** max open positions */
  maxOpenPositions: number;
  /** max trades per day (1-15) */
  maxTradesPerDay: number;
  /** max leverage */
  maxLeverage: number;
  /** max portfolio exposure in percent of equity */
  maxPortfolioExposurePct: number;
  /** max symbol exposure in percent of equity */
  maxSymbolExposurePct: number;
  /** max correlated-group exposure in percent of equity */
  maxCorrelatedExposurePct: number;
  /** fee percent applied on notional per fill */
  feePct: number;
  /** slippage percent applied to entries/exits */
  slippagePct: number;
  /** correlation groups: asset -> group id */
  correlationGroups: Record<string, string>;
}

export function validateStrategyConfig(cfg: StrategyConfig): void {
  if (cfg.minRr < PLATFORM_LIMITS.minRr) {
    throw new Error(`minRr below platform minimum ${PLATFORM_LIMITS.minRr}`);
  }
  if (cfg.tp1MinRr < cfg.minRr) {
    throw new Error("tp1MinRr cannot be below minRr");
  }
  if (cfg.swingStrength < 1 || cfg.swingStrength > 10) {
    throw new Error("swingStrength must be between 1 and 10");
  }
  if (cfg.entryTolerancePct <= 0 || cfg.entryTolerancePct > 5) {
    throw new Error("entryTolerancePct must be in (0, 5]");
  }
  const closes = cfg.partialClosePlan.reduce((sum, i) => sum + i.closePct, 0);
  if (closes > 100) {
    throw new Error("partial close plan closes more than 100%");
  }
}

export function validateRiskConfig(cfg: RiskConfig): RiskConfig {
  return {
    ...cfg,
    riskPerTrade: clamp(
      cfg.riskPerTrade,
      PLATFORM_LIMITS.riskPerTradeMin,
      PLATFORM_LIMITS.riskPerTradeMax,
    ),
    maxDailyLossPct: clamp(
      cfg.maxDailyLossPct,
      PLATFORM_LIMITS.dailyLossMin,
      PLATFORM_LIMITS.dailyLossMax,
    ),
    maxDrawdownPct: clamp(
      cfg.maxDrawdownPct,
      PLATFORM_LIMITS.maxDrawdownMin,
      PLATFORM_LIMITS.maxDrawdownMax,
    ),
    maxOpenPositions: clamp(
      Math.floor(cfg.maxOpenPositions),
      1,
      PLATFORM_LIMITS.maxOpenPositions,
    ),
    // CRITICAL: hard ceiling of 15 enforced regardless of frontend input.
    maxTradesPerDay: clamp(
      Math.floor(cfg.maxTradesPerDay),
      1,
      PLATFORM_LIMITS.maxTradesPerDay,
    ),
    maxLeverage: clamp(
      cfg.maxLeverage,
      1,
      PLATFORM_LIMITS.maxLeverage,
    ),
    maxPortfolioExposurePct: clamp(
      cfg.maxPortfolioExposurePct,
      1,
      PLATFORM_LIMITS.maxPortfolioExposureMax,
    ),
    maxSymbolExposurePct: clamp(
      cfg.maxSymbolExposurePct,
      1,
      PLATFORM_LIMITS.maxSymbolExposureMax,
    ),
    maxCorrelatedExposurePct: clamp(
      cfg.maxCorrelatedExposurePct,
      1,
      PLATFORM_LIMITS.maxCorrelatedExposureMax,
    ),
  };
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  version: "smc-v1.0.0",
  name: "SMC Strategy",
  symbol: "BTCUSDT",
  exchange: "binance",
  timeframes: { htf: "4H", mtf: "1H", ltf: "15M" },
  entryModels: {
    aggressive: false,
    confirmation: true,
    sweep: true,
    counterTrend: false,
  },
  minRr: 3,
  tp1MinRr: 1.5,
  swingStrength: 2,
  structureLookback: 300,
  displacementAtrMultiple: 1.5,
  atrPeriod: 14,
  equalLevelToleranceAtr: 0.15,
  setupMaxAgeMs: 1000 * 60 * 60 * 8,
  entryTolerancePct: 1.5,
  inducementEnabled: true,
  premiumDiscountEnabled: true,
  requirePremiumDiscount: false,
  significantSwings: 3,
  partialClosePlan: [
    { targetIndex: 1, closePct: 50, moveSlToBreakEven: true },
    { targetIndex: 2, closePct: 25, moveSlToBreakEven: false },
  ],
  breakEvenOnTp1: true,
  counterTrendMinRrMultiplier: 1.5,
};

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  riskPerTrade: 1,
  maxDailyLossPct: 3,
  maxDrawdownPct: 10,
  maxOpenPositions: 5,
  maxTradesPerDay: 10,
  maxLeverage: 10,
  maxPortfolioExposurePct: 200,
  maxSymbolExposurePct: 50,
  maxCorrelatedExposurePct: 100,
  feePct: 0.04,
  slippagePct: 0.05,
  correlationGroups: {
    BTCUSDT: "major",
    ETHUSDT: "major",
    SOLUSDT: "major",
    BNBUSDT: "major",
    XRPUSDT: "major",
    DOGEUSDT: "major",
  },
};

export function defaultStrategyConfigFor(
  symbol: string,
  exchange: string,
): StrategyConfig {
  return { ...DEFAULT_STRATEGY_CONFIG, symbol, exchange };
}
