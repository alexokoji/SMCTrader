import type { Candle, Timeframe } from "../types/candles.js";
import type { SupplyDemandZone } from "../types/poi.js";
import { atrValue, hashString } from "../util.js";

export interface SupplyDemandOptions {
  displacementAtrMultiple: number;
  maxZones: number;
}

export interface SupplyDemandUpdateResult {
  created: SupplyDemandZone[];
}

/**
 * Supply/Demand zones are the base immediately before a displacement move.
 * A demand zone sits below the displacement; a supply zone above it.
 */
export class SupplyDemandEngine {
  readonly symbol: string;
  readonly exchange: string;
  readonly timeframe: Timeframe;
  private candles: Candle[] = [];
  private zones: SupplyDemandZone[] = [];
  private opts: SupplyDemandOptions;

  constructor(
    symbol: string,
    exchange: string,
    timeframe: Timeframe,
    opts?: Partial<SupplyDemandOptions>,
  ) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = {
      displacementAtrMultiple: opts?.displacementAtrMultiple ?? 1.5,
      maxZones: opts?.maxZones ?? 60,
    };
  }

  update(candle: Candle): SupplyDemandUpdateResult {
    const created: SupplyDemandZone[] = [];
    if (
      this.candles.length > 0 &&
      candle.timestamp <= this.candles[this.candles.length - 1].timestamp
    ) {
      return { created };
    }
    this.candles.push(candle);
    const n = this.candles.length;
    if (n < 4) return { created };
    const a = atrValue(this.candles, 14, n - 1);
    if (!(a > 0)) return { created };
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);

    const isDisplacement =
      range >= a * this.opts.displacementAtrMultiple ||
      (body >= a * this.opts.displacementAtrMultiple * 0.7 && body > 0);

    const existingCount = this.zones.length;
    if (isDisplacement) {
      const bullish = candle.close > candle.open;
      // find base: scan back up to 5 candles for a compact cluster
      let baseStart = n - 2;
      let baseLow = Infinity;
      let baseHigh = -Infinity;
      for (let j = n - 2; j >= Math.max(0, n - 6); j--) {
        const base = this.candles[j];
        if (!base) break;
        const baseRange = base.high - base.low;
        if (baseRange > a * 1.2) break;
        baseLow = Math.min(baseLow, base.low);
        baseHigh = Math.max(baseHigh, base.high);
        baseStart = j;
      }
      if (n - 1 - baseStart >= 2 && Number.isFinite(baseLow)) {
        const kind = bullish ? "DEMAND" : "SUPPLY";
        const id = hashString(
          `${this.symbol}:${this.timeframe}:SD:${kind}:${baseLow.toFixed(8)}:${baseHigh.toFixed(8)}:${candle.timestamp}`,
        );
        const displacementRatio = Math.min(3, range / a);
        const zone: SupplyDemandZone = {
          id,
          symbol: this.symbol,
          exchange: this.exchange,
          timeframe: this.timeframe,
          kind,
          top: baseHigh,
          bottom: baseLow,
          candleIndex: baseStart,
          timestamp: this.candles[baseStart]?.timestamp ?? candle.timestamp,
          touchCount: 0,
          status: "FRESH",
          rank: Math.min(1, 0.4 + displacementRatio * 0.2),
        };
        this.zones.push(zone);
        created.push(zone);
      }
    }

    // Mitigate/touch only zones that existed before this candle so a zone is
    // never consumed by the very displacement that created it.
    const current = this.candles[n - 1];
    for (let i = 0; i < existingCount && i < this.zones.length; i++) {
      const zone = this.zones[i];
      if (zone.status === "MITIGATED") continue;
      if (current.low <= zone.bottom && current.close < zone.top) {
        zone.status = "MITIGATED";
        zone.mitigatedAt = current.timestamp;
      } else if (current.high >= zone.bottom && current.low <= zone.top) {
        zone.touchCount += 1;
        zone.rank = Math.max(0.1, zone.rank - 0.1 * zone.touchCount);
      }
    }

    if (this.zones.length > this.opts.maxZones) {
      this.zones = this.zones.slice(-this.opts.maxZones);
    }
    return { created };
  }

  getZones(): SupplyDemandZone[] {
    return this.zones;
  }

  fresh(kind: "SUPPLY" | "DEMAND"): SupplyDemandZone[] {
    return this.zones.filter((z) => z.kind === kind && z.status === "FRESH");
  }
}
