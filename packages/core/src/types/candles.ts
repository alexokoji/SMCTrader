export type Timeframe = "5M" | "15M" | "30M" | "1H" | "2H" | "4H" | "1D";

export type Side = "BUY" | "SELL";

export type Direction = "LONG" | "SHORT";

export type Trend = "BULLISH" | "BEARISH" | "RANGING" | "NEUTRAL";

export type CandlestickStatus = "OPEN" | "CLOSED";

export interface Candle {
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  /** open time in ms UTC */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleInterval {
  timeframe: Timeframe;
  /** milliseconds per candle */
  duration: number;
}

/** 5M, 15M, 30M, 1H, 2H, 4H, 1D */
export const TIMEFRAME_DURATION_MS: Record<Timeframe, number> = {
  "5M": 5 * 60 * 1000,
  "15M": 15 * 60 * 1000,
  "30M": 30 * 60 * 1000,
  "1H": 60 * 60 * 1000,
  "2H": 2 * 60 * 60 * 1000,
  "4H": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
};

export const TIMEFRAMES: Timeframe[] = [
  "5M",
  "15M",
  "30M",
  "1H",
  "2H",
  "4H",
  "1D",
];

export const TIMEFRAME_ORDER: Record<Timeframe, number> = {
  "5M": 0,
  "15M": 1,
  "30M": 2,
  "1H": 3,
  "2H": 4,
  "4H": 5,
  "1D": 6,
};

export function timeframeIsHigher(a: Timeframe, b: Timeframe): boolean {
  return TIMEFRAME_ORDER[a] > TIMEFRAME_ORDER[b];
}

export function timeframeDuration(tf: Timeframe): number {
  return TIMEFRAME_DURATION_MS[tf];
}

export interface Ticker {
  symbol: string;
  exchange: string;
  price: number;
  change24hPct: number;
  volume24h: number;
  timestamp: number;
}
