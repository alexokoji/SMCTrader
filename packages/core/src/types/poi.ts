import type { Timeframe } from "./candles.js";

export type PoiStatus = "FRESH" | "MITIGATED";

export interface Fvg {
  id: string;
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  direction: "BULLISH" | "BEARISH";
  top: number;
  bottom: number;
  size: number;
  /** timestamp of the 3rd (confirming) candle */
  timestamp: number;
  candleIndex: number;
  status: PoiStatus;
  /** true until price trades inside the gap */
  mitigatedAt?: number;
}

export interface OrderBlock {
  id: string;
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  direction: "BULLISH" | "BEARISH";
  top: number;
  bottom: number;
  /** index of the originating candle */
  candleIndex: number;
  timestamp: number;
  touchCount: number;
  status: PoiStatus;
  mitigatedAt?: number;
  strength: number;
  associatedFvgId?: string;
  associatedLiquidityId?: string;
  associatedStructureEventId?: string;
}

export interface SupplyDemandZone {
  id: string;
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  kind: "SUPPLY" | "DEMAND";
  top: number;
  bottom: number;
  candleIndex: number;
  timestamp: number;
  touchCount: number;
  status: PoiStatus;
  mitigatedAt?: number;
  /** aggregate quality 0..1 */
  rank: number;
}

export interface PoiZone {
  kind: "FVG" | "ORDER_BLOCK" | "SUPPLY" | "DEMAND";
  id: string;
  direction: "BULLISH" | "BEARISH";
  top: number;
  bottom: number;
  timeframe: Timeframe;
  createdAt: number;
  status: PoiStatus;
  strength: number;
  /** narrative used in explanations */
  label: string;
}
