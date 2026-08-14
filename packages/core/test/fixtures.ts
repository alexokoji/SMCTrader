import type { Candle, Timeframe } from "../src/types/candles.js";
import { TIMEFRAME_DURATION_MS } from "../src/types/candles.js";

export const EXCHANGE = "test";
export const SYMBOL = "BTCUSDT";

/** Base wall-clock time so stale/duplicate protection behaves realistically. */
export const NOW_BASE = Date.now();

export function mkCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  openTime: number,
  timeframe: Timeframe,
  volume = 100,
): Candle {
  return {
    symbol: SYMBOL,
    exchange: EXCHANGE,
    timeframe,
    timestamp: openTime,
    open,
    high,
    low,
    close,
    volume,
  };
}

export function sequence(
  moves: Array<[number, number, number, number]>,
  timeframe: Timeframe,
  startTime = NOW_BASE,
): Candle[] {
  const dur = TIMEFRAME_DURATION_MS[timeframe];
  return moves.map(([o, h, l, c], i) =>
    mkCandle(o, h, l, c, startTime + i * dur, timeframe),
  );
}

/**
 * Trend unit (validated against the swing detector, strength 2).
 * Each unit is 4 candles: A (into trough), B (swing HIGH), C (pullback),
 * D (swing LOW). With a positive step the structure is bullish (HH/HL);
 * with a negative step it is bearish (LH/LL).
 *
 *   A: open  T+0.2 high T+1.2 low T+0.1 close T+1.0
 *   B: open  T+1.0 high H     low T+0.9 close H-0.1   (H = T+2.2)
 *   C: open  H-0.1 high H-0.2 low H-1.6 close H-1.7
 *   D: open  H-1.7 high H-1.5 low T'    close T'+0.1  (T' = T+step)
 */
export function trendUnits(
  count: number,
  firstTrough: number,
  step: number,
  timeframe: Timeframe,
  startTime = NOW_BASE,
): Candle[] {
  const dur = TIMEFRAME_DURATION_MS[timeframe];
  const out: Candle[] = [];
  let t = startTime;
  for (let k = 0; k < count; k++) {
    const T = firstTrough + k * step;
    const H = T + 2.2;
    const Tp = T + step;
    const moves: Array<[number, number, number, number]> = [
      [T + 0.2, T + 1.2, T + 0.1, T + 1.0],
      [T + 1.0, H, T + 0.9, H - 0.1],
      [H - 0.1, H - 0.2, H - 1.6, H - 1.7],
      [H - 1.7, H - 1.5, Tp, Tp + 0.1],
    ];
    for (const [o, h, l, c] of moves) {
      out.push(mkCandle(o, h, l, c, t, timeframe));
      t += dur;
    }
  }
  return out;
}

/** Ascending HH/HL staircase. */
export function bullishStructure(timeframe: Timeframe, scale = 1): Candle[] {
  return trendUnits(8, 90 * scale, 0.4 * scale, timeframe);
}

/** Descending LH/LL staircase. */
export function bearishStructure(timeframe: Timeframe, scale = 1): Candle[] {
  return trendUnits(8, 100 * scale, -0.5 * scale, timeframe);
}

/**
 * LTF that ends in a valid confirmation LONG setup:
 * bearish LH/LL trend, SSL sweep with rejection, bullish CHoCH impulse,
 * pullback into the fresh order block.
 */
export function bullishReversalLtf(timeframe: Timeframe = "15M"): Candle[] {
  const base = trendUnits(6, 100, -0.5, timeframe);
  const startTime = base[base.length - 1].timestamp + TIMEFRAME_DURATION_MS[timeframe];
  const moves: Array<[number, number, number, number]> = [
    [97.8, 98.1, 97.25, 97.5], // sweep candle: wick below the swing low, bearish close
    [97.5, 103.0, 97.4, 102.9], // bullish displacement -> CHoCH, order block above the sweep
    [102.9, 103.2, 101.2, 101.4], // pullback 1
    [101.4, 101.7, 99.6, 99.8], // pullback 2
    [99.8, 100.1, 98.5, 98.7], // pullback 3
    [98.7, 99.0, 98.0, 98.1], // dips into the order block (touch, not mitigated)
    [98.1, 98.6, 97.8, 98.3], // resting at the order block top
  ];
  return [...base, ...sequence(moves, timeframe, startTime)];
}

/**
 * LTF that ends in a valid confirmation SHORT setup:
 * bullish HH/HL trend, BSL sweep with rejection, bearish CHoCH impulse,
 * pullback into the fresh order block.
 */
export function bearishReversalLtf(timeframe: Timeframe = "15M"): Candle[] {
  const base = trendUnits(6, 90, 0.5, timeframe);
  const startTime = base[base.length - 1].timestamp + TIMEFRAME_DURATION_MS[timeframe];
  const moves: Array<[number, number, number, number]> = [
    [93.4, 95.0, 93.3, 93.6], // sweep candle: wick above the swing high, bullish close
    [93.6, 93.7, 88.6, 88.7], // bearish displacement -> CHoCH, order block below the sweep
    [88.7, 91.2, 88.6, 91.0], // pullback 1
    [91.0, 93.0, 90.9, 92.8], // pullback 2
    [92.8, 94.0, 92.7, 93.8], // dips into the order block (touch, not mitigated)
    [93.8, 94.3, 93.5, 94.1], // resting at the order block bottom
  ];
  return [...base, ...sequence(moves, timeframe, startTime)];
}

export function alignedBullishSetup(): Partial<Record<Timeframe, Candle[]>> {
  return {
    "4H": bullishStructure("4H", 1),
    "1H": bullishStructure("1H", 1),
    "15M": bullishReversalLtf("15M"),
  };
}

export function alignedBearishSetup(): Partial<Record<Timeframe, Candle[]>> {
  return {
    "4H": bearishStructure("4H", 1),
    "1H": bearishStructure("1H", 1),
    "15M": bearishReversalLtf("15M"),
  };
}

export function last(candles: Candle[]): Candle {
  return candles[candles.length - 1];
}
