import type { Candle, Timeframe } from "../types/candles.js";
import type {
  LiquiditySource,
  LiquidityStatus,
  LiquidityType,
  LiquidityZone,
  SweepEvent,
} from "../types/liquidity.js";
import type { SwingPoint } from "../types/structure.js";
import { atr, hashString } from "../util.js";
import { detectSwings } from "./swing.js";

export interface LiquidityEngineOptions {
  strength: number;
  toleranceAtr: number;
}

export interface LiquidityUpdateResult {
  zones: LiquidityZone[];
  sweeps: SweepEvent[];
}

export class LiquidityEngine {
  readonly symbol: string;
  readonly exchange: string;
  readonly timeframe: Timeframe;
  private candles: Candle[] = [];
  private zones: LiquidityZone[] = [];
  private opts: LiquidityEngineOptions;
  private lastSwingIndex = -1;

  constructor(
    symbol: string,
    exchange: string,
    timeframe: Timeframe,
    opts?: Partial<LiquidityEngineOptions>,
  ) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = {
      strength: opts?.strength ?? 2,
      toleranceAtr: opts?.toleranceAtr ?? 0.15,
    };
  }

  update(candle: Candle): LiquidityUpdateResult {
    if (
      this.candles.length > 0 &&
      candle.timestamp <= this.candles[this.candles.length - 1].timestamp
    ) {
      return { zones: this.zones, sweeps: [] };
    }
    this.candles.push(candle);
    this.processSwings();
    return this.checkSweeps(candle);
  }

  private tolerance(index: number): number {
    const a = atr(this.candles, 14)[index];
    return Number.isFinite(a) && a > 0 ? a * this.opts.toleranceAtr : 0.01;
  }

  private processSwings(): void {
    const swings = detectSwings(this.candles, { strength: this.opts.strength });
    for (const sw of swings) {
      if (sw.index <= this.lastSwingIndex) continue;
      this.lastSwingIndex = sw.index;
      this.addZoneFromSwing(sw);
    }
    this.prune();
  }

  private addZoneFromSwing(sw: SwingPoint): void {
    const tol = this.tolerance(sw.index);
    if (sw.kind === "HIGH") {
      const existing = this.findNearby(sw.price, "BSL", tol);
      if (existing) {
        existing.interactions += 1;
        existing.source = "EQUAL_HIGH";
        existing.strength = Math.min(1, existing.strength + 0.15);
        if (sw.price > existing.level) existing.level = sw.price;
        existing.top = existing.level + tol;
        existing.bottom = existing.level - tol;
        return;
      }
      this.zones.push(this.buildZone(sw, "BSL", "SWING_HIGH", tol));
    } else {
      const existing = this.findNearby(sw.price, "SSL", tol);
      if (existing) {
        existing.interactions += 1;
        existing.source = "EQUAL_LOW";
        existing.strength = Math.min(1, existing.strength + 0.15);
        if (sw.price < existing.level) existing.level = sw.price;
        existing.top = existing.level + tol;
        existing.bottom = existing.level - tol;
        return;
      }
      this.zones.push(this.buildZone(sw, "SSL", "SWING_LOW", tol));
    }
  }

  private buildZone(
    sw: SwingPoint,
    type: LiquidityType,
    source: LiquiditySource,
    tol: number,
  ): LiquidityZone {
    const id = hashString(
      `${this.symbol}:${this.timeframe}:${type}:${sw.price.toFixed(8)}:${sw.timestamp}`,
    );
    return {
      id,
      symbol: this.symbol,
      exchange: this.exchange,
      type,
      timeframe: this.timeframe,
      level: sw.price,
      top: sw.price + tol,
      bottom: sw.price - tol,
      source,
      createdAt: sw.timestamp,
      strength: Math.max(0.4, Math.min(1, sw.strength + 0.3)),
      status: "ACTIVE",
      interactions: 1,
    };
  }

  private findNearby(
    price: number,
    type: LiquidityType,
    tol: number,
  ): LiquidityZone | undefined {
    return this.zones
      .filter((z) => z.type === type && z.status !== "SWEPT")
      .find((z) => Math.abs(z.level - price) <= tol * 1.5);
  }

  private prune(): void {
    if (this.zones.length > 200) {
      this.zones = this.zones.slice(-200);
    }
  }

  private checkSweeps(candle: Candle): LiquidityUpdateResult {
    const sweeps: SweepEvent[] = [];
    const index = this.candles.length - 1;
    for (const zone of this.zones) {
      if (zone.status === "SWEPT") continue;
      if (zone.type === "BSL") {
        if (candle.high >= zone.level) {
          zone.status = "SWEPT";
          zone.sweptAt = candle.timestamp;
          sweeps.push({
            type: "LIQUIDITY_SWEEP",
            symbol: this.symbol,
            exchange: this.exchange,
            timeframe: this.timeframe,
            direction: "SHORT",
            zoneId: zone.id,
            level: zone.level,
            extremePrice: candle.high,
            closePrice: candle.close,
            candleIndex: index,
            timestamp: candle.timestamp,
            rejected: candle.close < zone.level,
            structureShiftAfter: false,
          });
        } else if (candle.high >= zone.bottom) {
          if (zone.status === "ACTIVE") {
            zone.status = "PARTIALLY_SWEPT";
            zone.interactions += 1;
          }
        }
      } else {
        if (candle.low <= zone.level) {
          zone.status = "SWEPT";
          zone.sweptAt = candle.timestamp;
          sweeps.push({
            type: "LIQUIDITY_SWEEP",
            symbol: this.symbol,
            exchange: this.exchange,
            timeframe: this.timeframe,
            direction: "LONG",
            zoneId: zone.id,
            level: zone.level,
            extremePrice: candle.low,
            closePrice: candle.close,
            candleIndex: index,
            timestamp: candle.timestamp,
            rejected: candle.close > zone.level,
            structureShiftAfter: false,
          });
        } else if (candle.low <= zone.top) {
          if (zone.status === "ACTIVE") {
            zone.status = "PARTIALLY_SWEPT";
            zone.interactions += 1;
          }
        }
      }
    }
    return { zones: this.zones, sweeps };
  }

  getZones(): LiquidityZone[] {
    return this.zones;
  }

  activeZones(): LiquidityZone[] {
    return this.zones.filter((z) => z.status !== "SWEPT");
  }

  /** BSL levels resting above current price (potential long targets) */
  above(price: number): LiquidityZone[] {
    return this.zones
      .filter((z) => z.type === "BSL" && z.level > price)
      .sort((a, b) => a.level - b.level);
  }

  /** SSL levels resting below current price (potential short targets) */
  below(price: number): LiquidityZone[] {
    return this.zones
      .filter((z) => z.type === "SSL" && z.level < price)
      .sort((a, b) => b.level - a.level);
  }
}
