import type { Timeframe } from "./candles.js";

export type LiquidityType = "BSL" | "SSL";

export type LiquiditySource =
  | "SWING_HIGH"
  | "EQUAL_HIGH"
  | "RANGE_HIGH"
  | "SWING_LOW"
  | "EQUAL_LOW"
  | "RANGE_LOW";

export type LiquidityStatus = "ACTIVE" | "PARTIALLY_SWEPT" | "SWEPT";

export interface LiquidityZone {
  id: string;
  symbol: string;
  exchange: string;
  type: LiquidityType;
  timeframe: Timeframe;
  /** reference price of the liquidity pool */
  level: number;
  /** BSL: level .. level + tolerance, SSL: level - tolerance .. level */
  top: number;
  bottom: number;
  source: LiquiditySource;
  createdAt: number;
  strength: number;
  status: LiquidityStatus;
  interactions: number;
  /** whether price has reacted off this level before */
  sweptAt?: number;
}

export interface SweepEvent {
  type: "LIQUIDITY_SWEEP";
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  direction: "LONG" | "SHORT";
  zoneId: string;
  level: number;
  /** extreme price reached (wick) */
  extremePrice: number;
  /** close of the sweep candle */
  closePrice: number;
  candleIndex: number;
  timestamp: number;
  /** true when close returned beyond the swept level (rejection) */
  rejected: boolean;
  /** true when a structure shift followed the sweep */
  structureShiftAfter: boolean;
}
