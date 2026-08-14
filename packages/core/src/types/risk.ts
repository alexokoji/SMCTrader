import type { Direction } from "./candles.js";

export interface PositionSizingResult {
  riskPct: number;
  accountEquity: number;
  riskAmount: number;
  entry: number;
  stopLoss: number;
  slDistance: number;
  positionSize: number;
  notional: number;
  margin: number;
  leverageUsed: number;
  minQuantity?: number;
  stepSize?: number;
  warnings: string[];
}

export type RiskLimitKind =
  | "DAILY_TRADE_LIMIT"
  | "DAILY_LOSS_LIMIT"
  | "MAX_DRAWDOWN"
  | "MAX_OPEN_POSITIONS"
  | "MAX_PORTFOLIO_EXPOSURE"
  | "MAX_SYMBOL_EXPOSURE"
  | "MAX_CORRELATED_EXPOSURE"
  | "MAX_LEVERAGE"
  | "MIN_RR";

export interface RiskLimitState {
  kind: RiskLimitKind;
  limit: number;
  current: number;
  allowed: boolean;
  detail: string;
}

export interface RiskRejection {
  kind: RiskLimitKind;
  message: string;
}

export interface RiskDecision {
  allowed: boolean;
  reasons: RiskRejection[];
  limits: RiskLimitState[];
  sizing?: PositionSizingResult;
}

export interface PortfolioPosition {
  id: string;
  symbol: string;
  exchange: string;
  direction: Direction;
  setupId: string;
  strategyVersion: string;
  entry: number;
  positionSize: number;
  notional: number;
  stopLoss: number;
  takeProfits: number[];
  partialPlan: PartialClosePlanItem[];
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: number;
}

export interface PartialClosePlanItem {
  targetIndex: number;
  closePct: number;
  moveSlToBreakEven: boolean;
}

export interface RiskState {
  symbol: string;
  exchange: string;
  equity: number;
  equityDayStart: number;
  peakEquity: number;
  tradesToday: number;
  realizedPnlToday: number;
  openPositions: PortfolioPosition[];
  usedExposure: number;
  usedCorrelatedExposure: number;
  dailyLossReached: boolean;
  drawdownReached: boolean;
}
