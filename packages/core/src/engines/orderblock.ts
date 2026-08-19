import type { Candle, Timeframe } from "../types/candles.js";
import type { OrderBlock } from "../types/poi.js";
import { atr, hashString } from "../util.js";

export interface OrderBlockEngineOptions {
  displacementAtrMultiple: number;
  maxBlocks: number;
  /**
   * How far back to look for the candle that originated an impulse. An order
   * block is the last opposite-colour candle before the move, which is often
   * several bars behind the displacement candle rather than immediately behind
   * it.
   */
  impulseLookback: number;
}

export interface OrderBlockUpdateResult {
  created: OrderBlock[];
  mitigated: OrderBlock[];
}

export class OrderBlockEngine {
  readonly symbol: string;
  readonly exchange: string;
  readonly timeframe: Timeframe;
  private candles: Candle[] = [];
  private blocks: OrderBlock[] = [];
  /** Candle index each block was created on, used to defer mitigation checks. */
  private creationIndex = new Map<string, number>();
  private opts: OrderBlockEngineOptions;

  constructor(
    symbol: string,
    exchange: string,
    timeframe: Timeframe,
    opts?: Partial<OrderBlockEngineOptions>,
  ) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = {
      displacementAtrMultiple: opts?.displacementAtrMultiple ?? 1.5,
      maxBlocks: opts?.maxBlocks ?? 80,
      impulseLookback: opts?.impulseLookback ?? 5,
    };
  }

  update(candle: Candle): OrderBlockUpdateResult {
    const created: OrderBlock[] = [];
    const mitigated: OrderBlock[] = [];
    if (
      this.candles.length > 0 &&
      candle.timestamp <= this.candles[this.candles.length - 1].timestamp
    ) {
      return { created, mitigated };
    }
    this.candles.push(candle);
    const n = this.candles.length;
    const atrs = atr(this.candles, 14);
    const i = n - 1;
    const a = atrs[i];
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    const displacement =
      Number.isFinite(a) && a > 0 &&
      (range >= a * this.opts.displacementAtrMultiple ||
        (body >= a * this.opts.displacementAtrMultiple * 0.8 && body > 0));

    if (displacement && n >= 2) {
      const impulseIsUp = candle.close > candle.open;
      // Walk back through the impulse leg to the last candle that closed
      // against it. Requiring that candle to sit immediately behind the
      // displacement bar discards most real order blocks, because an impulse
      // usually spans several candles in the same direction.
      const originIndex = this.findImpulseOrigin(n - 1, impulseIsUp);
      if (originIndex >= 0) {
        const origin = this.candles[originIndex];
        const block = this.build(
          impulseIsUp ? "BULLISH" : "BEARISH",
          origin.low,
          origin.high,
          originIndex,
          origin.timestamp,
          a,
        );
        this.creationIndex.set(block.id, n - 1);
        created.push(block);
      }
    }

    const current = this.candles[n - 1];
    for (const block of this.blocks) {
      if (block.status === "MITIGATED") continue;
      // The displacement candle that created a block necessarily trades through
      // it, so mitigation is only assessed from the following candle onwards.
      if (n - 1 <= (this.creationIndex.get(block.id) ?? -1)) continue;
      if (current.low <= block.bottom || current.high >= block.top) {
        if (current.high >= block.top && current.close < block.bottom) {
          block.status = "MITIGATED";
          block.mitigatedAt = current.timestamp;
          mitigated.push(block);
        } else if (current.low <= block.bottom && current.close > block.top) {
          block.status = "MITIGATED";
          block.mitigatedAt = current.timestamp;
          mitigated.push(block);
        } else if (current.high >= block.bottom && current.low <= block.top) {
          block.touchCount += 1;
        }
      }
    }
    if (this.blocks.length > this.opts.maxBlocks) {
      this.blocks = this.blocks.slice(-this.opts.maxBlocks);
    }
    return { created, mitigated };
  }

  private build(
    direction: "BULLISH" | "BEARISH",
    bottom: number,
    top: number,
    candleIndex: number,
    timestamp: number,
    atrValue: number,
  ): OrderBlock {
    const id = hashString(
      `${this.symbol}:${this.timeframe}:OB:${direction}:${bottom.toFixed(8)}:${timestamp}`,
    );
    const range = Math.abs(top - bottom);
    const displacement = Number.isFinite(atrValue) && atrValue > 0 ? range / atrValue : 1;
    const strength = Math.min(1, 0.35 + displacement * 0.4);
    const block: OrderBlock = {
      id,
      symbol: this.symbol,
      exchange: this.exchange,
      timeframe: this.timeframe,
      direction,
      top,
      bottom,
      candleIndex,
      timestamp,
      touchCount: 0,
      status: "FRESH",
      strength,
    };
    this.blocks.push(block);
    return block;
  }

  /**
   * Index of the last candle closing against an impulse that ends at
   * `endIndex`, or -1 when the impulse has no such origin in range.
   */
  private findImpulseOrigin(endIndex: number, impulseIsUp: boolean): number {
    for (let k = 1; k <= this.opts.impulseLookback; k++) {
      const index = endIndex - k;
      if (index < 0) return -1;
      const c = this.candles[index];
      const body = c.close - c.open;
      if (body === 0) continue;
      if (impulseIsUp ? body < 0 : body > 0) return index;
    }
    return -1;
  }

  getBlocks(): OrderBlock[] {
    return this.blocks;
  }

  fresh(direction: "BULLISH" | "BEARISH"): OrderBlock[] {
    return this.blocks.filter((b) => b.direction === direction && b.status === "FRESH");
  }
}
