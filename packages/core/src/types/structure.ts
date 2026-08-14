import type { Timeframe, Trend } from "./candles.js";

export type SwingKind = "HIGH" | "LOW";

export interface SwingPoint {
  /** index into the candle array */
  index: number;
  timestamp: number;
  price: number;
  kind: SwingKind;
  /** 0..1 significance based on surrounding bars */
  strength: number;
}

export type StructurePointKind =
  | "HH"
  | "HL"
  | "LH"
  | "LL"
  | "SWING_HIGH"
  | "SWING_LOW";

export interface StructurePoint {
  index: number;
  timestamp: number;
  price: number;
  kind: StructurePointKind;
  /** true when this point is part of the current major (external) structure */
  external: boolean;
  createdAt: number;
}

export type StructureClass = "BULLISH" | "BEARISH" | "RANGING" | "NEUTRAL";

export interface MarketStructureState {
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  points: StructurePoint[];
  /** overall directional state */
  trend: Trend;
  /** strong when multiple confirmed sequences exist, weak otherwise */
  strength: "STRONG" | "WEAK";
  lastSwingHigh?: StructurePoint;
  lastSwingLow?: StructurePoint;
  updatedAt: number;
}

export interface StructureSnapshot {
  trend: Trend;
  strength: "STRONG" | "WEAK";
  /** e.g. "HH → HL → HH" */
  sequence: string[];
  lastSwingHigh?: { price: number; timestamp: number };
  lastSwingLow?: { price: number; timestamp: number };
  externalHigh?: number;
  externalLow?: number;
}

export type BoSDirection = "BULLISH" | "BEARISH";

export interface BosEvent {
  type: "BOS_CONFIRMED";
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  direction: BoSDirection;
  brokenLevel: number;
  confirmationPrice: number;
  candleIndex: number;
  timestamp: number;
  /** "STRONG" | "WEAK" */
  strength: "STRONG" | "WEAK";
  previousStructure: Trend;
  resultingStructure: Trend;
}

export type ChochStatus =
  | "POTENTIAL"
  | "CONFIRMED"
  | "FAILED";

export interface ChochEvent {
  type: "CHOCH";
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  direction: BoSDirection;
  brokenLevel: number;
  confirmationPrice: number;
  candleIndex: number;
  timestamp: number;
  status: ChochStatus;
  /** true when the CHoCH broke a level that was also swept for liquidity */
  causedBySweep: boolean;
  previousTrend: Trend;
  resultingTrend: Trend;
}
