import type { Candle } from "../types/candles.js";
import type { SwingKind, SwingPoint } from "../types/structure.js";
import { atr } from "../util.js";

export interface SwingDetectorOptions {
  /** bars required on each side of a pivot */
  strength: number;
}

/**
 * Deterministic pivot (swing) detection.
 * A swing high at index i requires high[i] strictly greater than the highs of
 * `strength` candles on each side. A swing low similarly for lows.
 *
 * IMPORTANT: a pivot is only emitted once the confirming candles to its right
 * have closed, so there is no look-ahead.
 */
export function detectSwings(
  candles: Candle[],
  options: SwingDetectorOptions,
): SwingPoint[] {
  const s = Math.max(1, Math.floor(options.strength));
  const n = candles.length;
  if (n < 2 * s + 1) return [];

  const atrs = atr(candles, 14);
  const swings: SwingPoint[] = [];

  for (let i = s; i < n - s; i++) {
    const c = candles[i];
    if (!c) continue;
    let isHigh = true;
    let isLow = true;
    let adjacentHigh = -Infinity;
    let adjacentLow = Infinity;
    for (let j = i - s; j <= i + s; j++) {
      if (j === i) continue;
      const o = candles[j];
      if (!o) continue;
      if (o.high >= c.high) isHigh = false;
      if (o.low <= c.low) isLow = false;
      if (o.high > adjacentHigh) adjacentHigh = o.high;
      if (o.low < adjacentLow) adjacentLow = o.low;
    }
    const a = atrs[i] ?? NaN;
    const kind: SwingKind | null = isHigh && isLow ? null : isHigh ? "HIGH" : isLow ? "LOW" : null;
    if (kind) {
      let strengthVal = 0.5;
      if (Number.isFinite(a) && a > 0) {
        strengthVal = kind === "HIGH"
          ? clamp01((c.high - adjacentHigh) / a)
          : clamp01((adjacentLow - c.low) / a);
      }
      swings.push({
        index: i,
        timestamp: c.timestamp,
        price: kind === "HIGH" ? c.high : c.low,
        kind,
        strength: strengthVal,
      });
    }
  }
  return swings;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
