import type { Candle, Timeframe } from "../types/candles.js";
import { atrValue } from "../util.js";

export interface MomentumState {
  /** displacement of latest candle vs ATR */
  displacement: number;
  /** consecutive candles in the same direction */
  consecutiveDirection: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  impulse: boolean;
  label: string;
  score: number;
}

export class MomentumEngine {
  readonly symbol: string;
  readonly exchange: string;
  readonly timeframe: Timeframe;
  private candles: Candle[] = [];
  private opts: { atrPeriod: number };

  constructor(
    symbol: string,
    exchange: string,
    timeframe: Timeframe,
    opts?: { atrPeriod?: number },
  ) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = { atrPeriod: opts?.atrPeriod ?? 14 };
  }

  update(candle: Candle): MomentumState {
    if (
      this.candles.length > 0 &&
      candle.timestamp <= this.candles[this.candles.length - 1].timestamp
    ) {
      return this.evaluate();
    }
    this.candles.push(candle);
    return this.evaluate();
  }

  evaluate(): MomentumState {
    const n = this.candles.length;
    if (n < 3) {
      return {
        displacement: 0,
        consecutiveDirection: 0,
        direction: "NEUTRAL",
        impulse: false,
        label: "Insufficient data",
        score: 0,
      };
    }
    const a = atrValue(this.candles, this.opts.atrPeriod, n - 1);
    const last = this.candles[n - 1];
    const range = last ? last.high - last.low : 0;
    const displacement = a > 0 ? range / a : 0;

    let consecutiveDirection = 1;
    let direction: "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
    if (last) {
      direction = last.close > last.open ? "UP" : last.close < last.open ? "DOWN" : "NEUTRAL";
    }
    let runRangeSum = range;
    for (let i = n - 2; i >= 0; i--) {
      const c = this.candles[i];
      if (!c) break;
      const dir = c.close > c.open ? "UP" : c.close < c.open ? "DOWN" : "NEUTRAL";
      if (dir === direction && dir !== "NEUTRAL") {
        consecutiveDirection++;
        runRangeSum += c.high - c.low;
      } else {
        break;
      }
    }

    // An impulse is a sustained run of directional candles whose average size
    // is at least the ATR. A lone strong candle is displacement, not impulse.
    const avgRunDisplacement =
      consecutiveDirection > 0 && a > 0 ? runRangeSum / consecutiveDirection / a : 0;
    const impulse = consecutiveDirection >= 3 && avgRunDisplacement >= 1;

    let label: string;
    if (impulse) label = direction === "UP" ? "Bullish impulse" : direction === "DOWN" ? "Bearish impulse" : "Impulse";
    else if (displacement >= 1.5) label = direction === "UP" ? "Strong upward displacement" : direction === "DOWN" ? "Strong downward displacement" : "Displacement";
    else if (consecutiveDirection >= 3) label = "Corrective / trending";
    else label = "Low momentum";

    const score = Math.min(
      1,
      Math.max(
        0,
        displacement / 3 * 0.6 + Math.min(1, consecutiveDirection / 5) * 0.4,
      ),
    );
    return { displacement, consecutiveDirection, direction, impulse, label, score };
  }
}
