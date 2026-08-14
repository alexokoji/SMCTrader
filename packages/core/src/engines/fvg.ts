import type { Candle, Timeframe } from "../types/candles.js";
import type { Fvg } from "../types/poi.js";
import { hashString } from "../util.js";

export interface FvgEngineOptions {
  maxZones: number;
}

export interface FvgUpdateResult {
  created: Fvg[];
  mitigated: Fvg[];
}

export class FvgEngine {
  readonly symbol: string;
  readonly exchange: string;
  readonly timeframe: Timeframe;
  private candles: Candle[] = [];
  private zones: Fvg[] = [];
  private opts: FvgEngineOptions;

  constructor(
    symbol: string,
    exchange: string,
    timeframe: Timeframe,
    opts?: Partial<FvgEngineOptions>,
  ) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = { maxZones: opts?.maxZones ?? 100 };
  }

  update(candle: Candle): FvgUpdateResult {
    const created: Fvg[] = [];
    const mitigated: Fvg[] = [];
    if (
      this.candles.length > 0 &&
      candle.timestamp <= this.candles[this.candles.length - 1].timestamp
    ) {
      return { created, mitigated };
    }
    this.candles.push(candle);
    const n = this.candles.length;
    if (n >= 3) {
      const a = this.candles[n - 3];
      const c = this.candles[n - 1];
      if (a && c) {
        let fvg: Fvg | undefined;
        if (a.high < c.low) {
          fvg = this.build("BULLISH", a.high, c.low, n - 1, c.timestamp);
        } else if (a.low > c.high) {
          fvg = this.build("BEARISH", c.high, a.low, n - 1, c.timestamp);
        }
        if (fvg) {
          created.push(fvg);
        }
      }
    }
    const current = this.candles[n - 1];
    for (const zone of this.zones) {
      if (zone.status === "MITIGATED") continue;
      if (
        (current.high >= zone.bottom && current.low <= zone.top) ||
        current.low <= zone.bottom ||
        current.high >= zone.top
      ) {
        zone.status = "MITIGATED";
        zone.mitigatedAt = current.timestamp;
        mitigated.push(zone);
      }
    }
    if (this.zones.length > this.opts.maxZones) {
      this.zones = this.zones.slice(-this.opts.maxZones);
    }
    return { created, mitigated };
  }

  private build(
    direction: "BULLISH" | "BEARISH",
    bottom: number,
    top: number,
    candleIndex: number,
    timestamp: number,
  ): Fvg {
    const id = hashString(
      `${this.symbol}:${this.timeframe}:FVG:${bottom.toFixed(8)}:${top.toFixed(8)}:${timestamp}`,
    );
    const zone: Fvg = {
      id,
      symbol: this.symbol,
      exchange: this.exchange,
      timeframe: this.timeframe,
      direction,
      top,
      bottom,
      size: Math.abs(top - bottom),
      timestamp,
      candleIndex,
      status: "FRESH",
    };
    this.zones.push(zone);
    return zone;
  }

  getZones(): Fvg[] {
    return this.zones;
  }

  /** fresh zones in the direction near price */
  fresh(direction: "BULLISH" | "BEARISH", maxAgeMs: number): Fvg[] {
    const now = this.candles.length ? this.candles[this.candles.length - 1].timestamp : 0;
    return this.zones.filter(
      (z) => z.direction === direction && z.status === "FRESH" && now - z.timestamp < maxAgeMs,
    );
  }
}
