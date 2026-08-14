import type { Candle } from "./types/candles.js";

export function round(n: number, decimals = 8): number {
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function max(values: number[]): number {
  return values.reduce((a, b) => (b > a ? b : a), -Infinity);
}

export function min(values: number[]): number {
  return values.reduce((a, b) => (b < a ? b : a), Infinity);
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Simple hash used for deterministic IDs. Not a security primitive. */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** True Range */
export function trueRange(prevClose: number, high: number, low: number): number {
  const a = high - low;
  const b = Math.abs(high - prevClose);
  const c = Math.abs(low - prevClose);
  return Math.max(a, b, c);
}

/** Wilder ATR over candles; returns array aligned with candle indices (NaN warmup). */
export function atr(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period + 1) return out;
  let prevClose = candles[0].close;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trueRange(prevClose, candles[i].high, candles[i].low);
    prevClose = candles[i].close;
  }
  let value = sum / period;
  out[period] = value;
  for (let i = period + 1; i < n; i++) {
    value =
      (value * (period - 1) + trueRange(prevClose, candles[i].high, candles[i].low)) /
      period;
    out[i] = value;
    prevClose = candles[i].close;
  }
  return out;
}

/**
 * ATR at `index` with a warmup fallback. The Wilder ATR is only defined once
 * `period + 1` candles are available; before that, fall back to the mean true
 * range over the candles available up to `index` so engines can reason about
 * volatility (displacement, momentum, zones) from the very first candles.
 */
export function atrValue(candles: Candle[], period: number, index: number): number {
  const warmed = atr(candles, period)[index];
  if (Number.isFinite(warmed) && warmed > 0) return warmed;
  let sum = 0;
  let count = 0;
  let prevClose = candles[0]?.close;
  for (let i = 1; i <= index && i < candles.length; i++) {
    const c = candles[i];
    if (!c || prevClose == null) break;
    sum += trueRange(prevClose, c.high, c.low);
    count += 1;
    prevClose = c.close;
  }
  return count > 0 ? sum / count : 0;
}

export function lastDefined<T>(arr: Array<T | undefined>): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== undefined) return arr[i];
  }
  return undefined;
}
