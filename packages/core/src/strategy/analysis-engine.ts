import type {
  Candle,
  Direction,
  Timeframe,
  Trend,
} from "../types/candles.js";
import type { LiquidityZone, SweepEvent } from "../types/liquidity.js";
import type {
  BosEvent,
  ChochEvent,
  StructureSnapshot,
} from "../types/structure.js";
import type { Fvg, OrderBlock, PoiZone, SupplyDemandZone } from "../types/poi.js";
import type {
  ConfluenceFactor,
  EntryModel,
  Setup,
  SetupComponents,
  SetupQuality,
  TimeframeAnalysis,
} from "../types/setup.js";
import type { StrategyConfig } from "../config/index.js";
import { FvgEngine } from "../engines/fvg.js";
import { LiquidityEngine } from "../engines/liquidity.js";
import { MomentumEngine } from "../engines/momentum.js";
import { OrderBlockEngine } from "../engines/orderblock.js";
import {
  describePd,
  pdPosition,
  premiumDiscountRatio,
} from "../engines/premiumdiscount.js";
import { SupplyDemandEngine } from "../engines/supplydemand.js";
import { MarketStructureEngine } from "../engines/structure.js";
import { atr, hashString } from "../util.js";
import { scoreSetup } from "./scoring.js";
import { snapshotToBias, topDownAnalysis } from "./topdown.js";

export type EngineEvent =
  | { type: "BOS"; timestamp: number; detail: string }
  | { type: "CHOCH"; timestamp: number; detail: string }
  | { type: "SWEEP"; timestamp: number; detail: string }
  | { type: "POI_REACHED"; timestamp: number; detail: string }
  | { type: "SETUP"; timestamp: number; detail: string }
  | { type: "INFO"; timestamp: number; detail: string };

export interface TimeframeSnapshot {
  timeframe: Timeframe;
  structure: StructureSnapshot;
  bos: BosEvent[];
  choch: ChochEvent[];
  sweeps: SweepEvent[];
  liquidityZones: LiquidityZone[];
  fvgs: Fvg[];
  orderBlocks: OrderBlock[];
  supplyDemand: SupplyDemandZone[];
  momentum: string;
  candles: Candle[];
}

export interface SymbolAnalysis {
  symbol: string;
  exchange: string;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCLEAR";
  topDown: TimeframeAnalysis;
  snapshots: Record<Timeframe, TimeframeSnapshot | undefined>;
  setups: Setup[];
  events: EngineEvent[];
  status: string;
  updatedAt: number;
}

interface TfEngines {
  structure: MarketStructureEngine;
  liquidity: LiquidityEngine;
  fvg: FvgEngine;
  ob: OrderBlockEngine;
  sd: SupplyDemandEngine;
  momentum: MomentumEngine;
}

interface PoiMatch {
  zone: PoiZone;
  source: Timeframe;
}

export class AnalysisEngine {
  readonly symbol: string;
  readonly exchange: string;
  cfg: StrategyConfig;
  private engines: Partial<Record<Timeframe, TfEngines>> = {};
  private candles: Partial<Record<Timeframe, Candle[]>> = {};
  private events: EngineEvent[] = [];
  private lastSetupKeys = new Set<string>();
  private lastStatus = "SCANNING";
  private setupCounter = 0;

  constructor(symbol: string, exchange: string, cfg: StrategyConfig) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.cfg = cfg;
    const tfs: Timeframe[] = [cfg.timeframes.htf, cfg.timeframes.mtf, cfg.timeframes.ltf];
    for (const tf of new Set(tfs)) {
      this.engines[tf] = {
        structure: new MarketStructureEngine(symbol, exchange, tf, {
          strength: cfg.swingStrength,
          lookback: cfg.structureLookback,
        }),
        liquidity: new LiquidityEngine(symbol, exchange, tf, {
          strength: cfg.swingStrength,
          toleranceAtr: cfg.equalLevelToleranceAtr,
        }),
        fvg: new FvgEngine(symbol, exchange, tf),
        ob: new OrderBlockEngine(symbol, exchange, tf, {
          displacementAtrMultiple: cfg.displacementAtrMultiple,
        }),
        sd: new SupplyDemandEngine(symbol, exchange, tf, {
          displacementAtrMultiple: cfg.displacementAtrMultiple,
        }),
        momentum: new MomentumEngine(symbol, exchange, tf, { atrPeriod: cfg.atrPeriod }),
      };
      this.candles[tf] = [];
    }
  }

  /**
   * Apply configuration changes that are safe to make at runtime. Structural
   * fields that define the engine graph (symbol, exchange, timeframes, swing
   * detection) must not change after construction and are rejected.
   */
  updateConfig(cfg: StrategyConfig): void {
    const runFor = (key: keyof StrategyConfig) => cfg[key] !== this.cfg[key];
    if (runFor("symbol") || runFor("exchange")) {
      throw new Error("symbol and exchange cannot be changed at runtime.");
    }
    if (
      cfg.timeframes.htf !== this.cfg.timeframes.htf ||
      cfg.timeframes.mtf !== this.cfg.timeframes.mtf ||
      cfg.timeframes.ltf !== this.cfg.timeframes.ltf
    ) {
      throw new Error("timeframes cannot be changed at runtime - restart required.");
    }
    if (runFor("swingStrength") || runFor("structureLookback")) {
      throw new Error("swingStrength and structureLookback cannot be changed at runtime - restart required.");
    }
    this.cfg = cfg;
  }

  /** Feed a CLOSED candle. Only the given timeframe is updated. */
  onCandleClosed(candle: Candle): void {
    const tf = candle.timeframe;
    const eng = this.engines[tf];
    if (!eng) return;
    const buf = this.candles[tf] ?? (this.candles[tf] = []);
    if (buf.length && buf[buf.length - 1].timestamp >= candle.timestamp) return;
    buf.push(candle);
    if (buf.length > 2000) buf.splice(0, buf.length - 2000);

    const structureResult = eng.structure.update(candle);
    const structureEvents = eng.structure.evaluate();
    for (const ev of structureEvents.bos) {
      this.events.push({
        type: "BOS",
        timestamp: ev.timestamp,
        detail: `${ev.direction} break of structure confirmed at ${ev.brokenLevel.toFixed(2)} (${tf}).`,
      });
    }
    for (const ev of structureEvents.choch) {
      this.events.push({
        type: "CHOCH",
        timestamp: ev.timestamp,
        detail: `${ev.direction} CHoCH confirmed at ${ev.brokenLevel.toFixed(2)} (${tf}).`,
      });
    }
    const liqResult = eng.liquidity.update(candle);
    for (const sw of liqResult.sweeps) {
      this.events.push({
        type: "SWEEP",
        timestamp: sw.timestamp,
        detail: `Sell-side liquidity swept at ${sw.level.toFixed(2)} (${tf})${sw.rejected ? " with rejection" : ""}.`,
      });
    }
    eng.fvg.update(candle);
    eng.ob.update(candle);
    eng.sd.update(candle);
    eng.momentum.update(candle);
    this.trimEvents();
  }

  private trimEvents(): void {
    if (this.events.length > 500) this.events = this.events.slice(-500);
  }

  /** Run a full analysis cycle over the current (closed-candle) state. */
  analyze(): SymbolAnalysis {
    const htf = this.cfg.timeframes.htf;
    const mtf = this.cfg.timeframes.mtf;
    const ltf = this.cfg.timeframes.ltf;

    const htfSnap = this.engines[htf]?.structure.snapshot();
    const mtfSnap = this.engines[mtf]?.structure.snapshot();
    const ltfSnap = this.engines[ltf]?.structure.snapshot();

    const td = htfSnap && mtfSnap && ltfSnap
      ? topDownAnalysis(
          snapshotToBias(htfSnap, htf),
          snapshotToBias(mtfSnap, mtf),
          snapshotToBias(ltfSnap, ltf),
        )
      : null;

    const bias = td?.bias ?? "UNCLEAR";

    const snapshots = this.buildSnapshots();
    const setups = this.buildSetups(td, snapshots);

    // only push new SETUP events for setups we have not logged
    for (const s of setups) {
      if (!this.lastSetupKeys.has(s.id)) {
        this.lastSetupKeys.add(s.id);
        this.events.push({
          type: "SETUP",
          timestamp: s.createdAt,
          detail: `${s.symbol} ${s.direction} ${s.entryModel} setup ${s.status === "REJECTED" ? `rejected — ${s.rejectionReasons[0] ?? "no reason"}` : `scored ${s.score}/100`}.`,
        });
      }
    }
    this.trimEvents();

    this.lastStatus = this.computeStatus(setups);

    const topDown: TimeframeAnalysis = td
      ? {
          htf: { timeframe: htf, trend: td.htf.trend, strength: td.htf.strength },
          mtf: { timeframe: mtf, trend: td.mtf.trend, strength: td.mtf.strength },
          ltf: { timeframe: ltf, trend: td.ltf.trend },
          conflict: td.conflict ?? undefined,
        }
      : { htf: { timeframe: htf, trend: "NEUTRAL", strength: "WEAK" }, mtf: { timeframe: mtf, trend: "NEUTRAL", strength: "WEAK" }, ltf: { timeframe: ltf, trend: "NEUTRAL" } };

    return {
      symbol: this.symbol,
      exchange: this.exchange,
      bias,
      topDown,
      snapshots,
      setups,
      events: this.events.slice(-80),
      status: this.lastStatus,
      updatedAt: this.now(),
    };
  }

  private computeStatus(setups: Setup[]): string {
    if (this.isSafe) return "SAFE_MODE";
    const valid = setups.filter((s) => s.status === "VALID");
    if (valid.length > 0) return "READY";
    const reject = setups.filter((s) => s.status === "REJECTED");
    if (reject.length > 0) return "REJECTED";
    return "WAITING_FOR_POI";
  }

  get isSafe(): boolean {
    return false;
  }

  private buildSnapshots(): Record<Timeframe, TimeframeSnapshot | undefined> {
    const out = {} as Record<Timeframe, TimeframeSnapshot | undefined>;
    for (const [tf, eng] of Object.entries(this.engines) as [Timeframe, TfEngines][]) {
      const structure = eng.structure.evaluate();
      out[tf] = {
        timeframe: tf,
        structure: eng.structure.snapshot(),
        bos: eng.structure.lastBosEvents,
        choch: eng.structure.lastChochEvents,
        sweeps: eng.liquidity.getZones().filter((z) => z.status === "SWEPT").slice(-20).map((z) => ({
          type: "LIQUIDITY_SWEEP" as const,
          symbol: this.symbol,
          exchange: this.exchange,
          timeframe: tf,
          direction: z.type === "BSL" ? "SHORT" : "LONG",
          zoneId: z.id,
          level: z.level,
          extremePrice: z.level,
          closePrice: z.level,
          candleIndex: -1,
          timestamp: z.sweptAt ?? z.createdAt,
          rejected: false,
          structureShiftAfter: false,
        })),
        liquidityZones: eng.liquidity.getZones().slice(-40),
        fvgs: eng.fvg.getZones().slice(-30),
        orderBlocks: eng.ob.getBlocks().slice(-30),
        supplyDemand: eng.sd.getZones().slice(-30),
        momentum: eng.momentum.evaluate().label,
        candles: this.candles[tf]?.slice(-250) ?? [],
      };
    }
    return out;
  }

  private now(): number {
    let max = 0;
    for (const buf of Object.values(this.candles)) {
      const last = buf?.[buf.length - 1];
      if (last && last.timestamp > max) max = last.timestamp;
    }
    return max;
  }

  /** Closed candles held for the given timeframe (used for last price etc). */
  candlesFor(tf: Timeframe): Candle[] {
    return this.candles[tf] ?? [];
  }

  // ------------------------------------------------------------------
  // Setup construction
  // ------------------------------------------------------------------

  private buildSetups(
    td: ReturnType<typeof topDownAnalysis> | null,
    snapshots: Record<Timeframe, TimeframeSnapshot | undefined>,
  ): Setup[] {
    const ltf = this.cfg.timeframes.ltf;
    const mtf = this.cfg.timeframes.mtf;
    const htf = this.cfg.timeframes.htf;
    const lastPrice = this.lastPriceOf(ltf);
    if (td === null || !lastPrice) return [];
    if ((this.candles[ltf]?.length ?? 0) < 30) return [];

    const setups: Setup[] = [];

    const longPoi = this.findPoi(lastPrice, "LONG", [mtf, ltf], snapshots);
    const shortPoi = this.findPoi(lastPrice, "SHORT", [mtf, ltf], snapshots);

    const models: EntryModel[] = [];
    if (this.cfg.entryModels.aggressive) models.push("AGGRESSIVE");
    if (this.cfg.entryModels.confirmation) models.push("CONFIRMATION");
    if (this.cfg.entryModels.sweep) models.push("SWEEP");
    if (this.cfg.entryModels.counterTrend) models.push("COUNTER_TREND");

    for (const model of models) {
      let direction: Direction | null = null;
      if (model === "COUNTER_TREND") {
        if (td.bias === "BEARISH") direction = "LONG";
        else if (td.bias === "BULLISH") direction = "SHORT";
        else direction = longPoi ? "LONG" : shortPoi ? "SHORT" : null;
      } else if (td.bias === "BEARISH") {
        direction = "SHORT";
      } else if (td.bias === "BULLISH") {
        direction = "LONG";
      } else if (td.bias === "NEUTRAL") {
        direction = longPoi && shortPoi ? null : longPoi ? "LONG" : shortPoi ? "SHORT" : null;
      }
      if (!direction) continue;

      const poi = direction === "LONG" ? longPoi : shortPoi;
      const setup = this.buildSetup(
        td,
        snapshots,
        direction,
        model,
        poi,
        lastPrice,
        ltf,
        mtf,
        htf,
      );
      if (setup) {
        const quality = this.evaluateQuality(setup, td, snapshots);
        setup.qualityFactors = quality.factors;
        setup.hardRules = quality.hardRules;
        setup.score = quality.score;
        setup.status = this.resolveSetupStatus(setup, quality);
        if (setup.status === "REJECTED") {
          setup.rejectionReasons = quality.rejections;
        }
        setups.push(setup);
      }
    }
    return setups;
  }

  private lastPriceOf(tf: Timeframe): number | undefined {
    const buf = this.candles[tf];
    const last = buf?.[buf.length - 1];
    return last ? last.close : undefined;
  }

  private findPoi(
    price: number,
    direction: Direction,
    sources: Timeframe[],
    snapshots: Record<Timeframe, TimeframeSnapshot | undefined>,
  ): PoiMatch | undefined {
    const tol = this.cfg.entryTolerancePct / 100;
    const candidates: PoiMatch[] = [];
    const buf = this.candles[this.cfg.timeframes.ltf];
    const lastIndex = buf ? buf.length - 1 : 0;
    const a = buf ? atr(buf, 14)[lastIndex] : 0;

    for (const tf of sources) {
      const snap = snapshots[tf];
      if (!snap) continue;
      if (direction === "LONG") {
        for (const z of snap.orderBlocks.filter((o) => o.direction === "BULLISH" && o.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "ORDER_BLOCK",
              id: z.id,
              direction: "BULLISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: z.strength,
              label: `${tf} bullish order block`,
            },
            source: tf,
          });
        }
        for (const z of snap.fvgs.filter((f) => f.direction === "BULLISH" && f.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "FVG",
              id: z.id,
              direction: "BULLISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: 0.6,
              label: `${tf} bullish fair value gap`,
            },
            source: tf,
          });
        }
        for (const z of snap.supplyDemand.filter((s) => s.kind === "DEMAND" && s.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "DEMAND",
              id: z.id,
              direction: "BULLISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: z.rank,
              label: `${tf} demand zone`,
            },
            source: tf,
          });
        }
      } else {
        for (const z of snap.orderBlocks.filter((o) => o.direction === "BEARISH" && o.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "ORDER_BLOCK",
              id: z.id,
              direction: "BEARISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: z.strength,
              label: `${tf} bearish order block`,
            },
            source: tf,
          });
        }
        for (const z of snap.fvgs.filter((f) => f.direction === "BEARISH" && f.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "FVG",
              id: z.id,
              direction: "BEARISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: 0.6,
              label: `${tf} bearish fair value gap`,
            },
            source: tf,
          });
        }
        for (const z of snap.supplyDemand.filter((s) => s.kind === "SUPPLY" && s.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "SUPPLY",
              id: z.id,
              direction: "BEARISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: z.rank,
              label: `${tf} supply zone`,
            },
            source: tf,
          });
        }
      }
    }

    const tolPrice = Math.max(price * tol, a * 0.5, price * 0.0001);
    const qualifying = candidates.filter((c) => {
      if (direction === "LONG") {
        return c.zone.bottom <= price + tolPrice && c.zone.top >= price - tolPrice;
      }
      return c.zone.bottom <= price + tolPrice && c.zone.top >= price - tolPrice;
    });

    if (qualifying.length === 0) return undefined;
    qualifying.sort((x, y) => {
      const dx = Math.abs(price - (x.zone.top + x.zone.bottom) / 2);
      const dy = Math.abs(price - (y.zone.top + y.zone.bottom) / 2);
      return dx - dy;
    });
    return qualifying[0];
  }

  private buildSetup(
    td: ReturnType<typeof topDownAnalysis>,
    snapshots: Record<Timeframe, TimeframeSnapshot | undefined>,
    direction: Direction,
    model: EntryModel,
    poi: PoiMatch | undefined,
    price: number,
    ltf: Timeframe,
    mtf: Timeframe,
    htf: Timeframe,
  ): Setup | undefined {
    if (!poi) return undefined;
    const zone = poi.zone;
    const entry =
      direction === "LONG"
        ? Math.max(zone.top, price * (1 - this.cfg.entryTolerancePct / 100))
        : Math.min(zone.bottom, price * (1 + this.cfg.entryTolerancePct / 100));

    const ltfSnap = snapshots[ltf];
    const mtfSnap = snapshots[mtf];
    const htfSnap = snapshots[htf];
    if (!ltfSnap || !mtfSnap || !htfSnap) return undefined;

    const a = this.atrAt(ltf);
    const buffer = Math.max(a * 0.1, entry * 0.0008);

    const structuralLow = ltfSnap.structure.lastSwingLow?.price;
    const structuralHigh = ltfSnap.structure.lastSwingHigh?.price;

    let stopLoss: number;
    let stopLossReason: string;
    if (direction === "LONG") {
      const belowZone = zone.bottom - buffer;
      const belowSwing = structuralLow !== undefined ? Math.min(structuralLow, zone.bottom) - buffer : belowZone;
      stopLoss = Math.min(belowZone, belowSwing);
      stopLossReason = `SL placed below the ${poi.source} ${zone.label} and the structural swing low because invalidation occurs if price closes through this level.`;
    } else {
      const aboveZone = zone.top + buffer;
      const aboveSwing = structuralHigh !== undefined ? Math.max(structuralHigh, zone.top) + buffer : aboveZone;
      stopLoss = Math.max(aboveZone, aboveSwing);
      stopLossReason = `SL placed above the ${poi.source} ${zone.label} and the structural swing high because invalidation occurs if price closes through this level.`;
    }

    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0) return undefined;

    const targets = this.computeTargets(direction, entry, risk, snapshots);
    const takeProfits = targets.targets;
    const takeProfitReasons = targets.reasons;
    const rr = takeProfits.map((t) => Math.abs(t - entry) / risk);

    if (takeProfits.length === 0) return undefined;

    const htfBias = td.bias;
    const counterTrend = direction === "LONG" ? htfBias === "BEARISH" : htfBias === "BULLISH";

    const id = hashString(
      `${this.symbol}:${direction}:${model}:${zone.id}:${entry.toFixed(4)}:${this.setupCounter++}:${this.now()}`,
    );

    const components = this.collectComponents(direction, snapshots, ltf, entry, risk, zone);

    const setup: Setup = {
      id,
      symbol: this.symbol,
      exchange: this.exchange,
      direction,
      timeframe: ltf,
      entryModel: model,
      htfTrend: htfBias === "UNCLEAR" ? "NEUTRAL" : htfBias,
      timeframeAnalysis: {
        htf: { timeframe: htf, trend: td.htf.trend, strength: td.htf.strength },
        mtf: { timeframe: mtf, trend: td.mtf.trend, strength: td.mtf.strength },
        ltf: { timeframe: ltf, trend: td.ltf.trend },
        conflict: td.conflict ?? undefined,
      },
      entry,
      stopLoss,
      stopLossReason,
      takeProfits,
      takeProfitReasons,
      rr,
      riskPct: 0,
      score: 0,
      qualityFactors: [],
      hardRules: [],
      factors: [],
      reasons: [],
      rejectionReasons: [],
      status: "VALIDATING",
      components,
      counterTrend,
      strategyVersion: this.cfg.version,
      createdAt: this.now(),
    };
    return setup;
  }

  private collectComponents(
    direction: Direction,
    snapshots: Record<Timeframe, TimeframeSnapshot | undefined>,
    ltf: Timeframe,
    entry: number,
    risk: number,
    zone: PoiZone,
  ): SetupComponents {
    const ltfSnap = snapshots[ltf];
    const components: SetupComponents = {
      poi: {
        kind: zone.kind,
        id: zone.id,
        top: zone.top,
        bottom: zone.bottom,
        strength: zone.strength,
        status: zone.status,
      },
    };
    if (ltfSnap) {
      const relevantSweeps =
        direction === "LONG"
          ? ltfSnap.sweeps.filter((s) => s.direction === "LONG").slice(-1)[0]
          : ltfSnap.sweeps.filter((s) => s.direction === "SHORT").slice(-1)[0];
      if (relevantSweeps) components.sweepEvent = relevantSweeps;
      const choch = ltfSnap.choch.at(-1);
      if (choch) components.chochEvent = choch;
      const ob = ltfSnap.orderBlocks
        .filter((o) => o.direction === (direction === "LONG" ? "BULLISH" : "BEARISH") && o.status === "FRESH")
        .at(-1);
      if (ob) components.orderBlockId = ob.id;
      const fvg = ltfSnap.fvgs
        .filter((f) => f.direction === (direction === "LONG" ? "BULLISH" : "BEARISH") && f.status === "FRESH")
        .at(-1);
      if (fvg) components.fvgId = fvg.id;
      const targets =
        direction === "LONG"
          ? ltfSnap.liquidityZones.filter((z) => z.type === "BSL" && z.level > entry).sort((a, b) => a.level - b.level)[0]
          : ltfSnap.liquidityZones.filter((z) => z.type === "SSL" && z.level < entry).sort((a, b) => b.level - a.level)[0];
      if (targets) {
        components.targetLiquidity = { type: targets.type, level: targets.level };
      }
      if (this.cfg.premiumDiscountEnabled) {
        const levels = [
          ltfSnap.structure.lastSwingHigh?.price,
          ltfSnap.structure.lastSwingLow?.price,
        ].filter((p): p is number => p !== undefined);
        if (levels.length === 2) {
          const ratio = premiumDiscountRatio(entry, { high: Math.max(...levels), low: Math.min(...levels), asOf: 0 });
          components.premiumDiscount = {
            position: pdPosition(ratio),
            ratio,
          };
        }
      }
      if (this.cfg.inducementEnabled) {
        const inducer =
          direction === "LONG"
            ? ltfSnap.liquidityZones
                .filter((z) => z.type === "SSL" && z.status === "ACTIVE" && z.level < entry)
                .sort((a, b) => b.level - a.level)[0]
            : ltfSnap.liquidityZones
                .filter((z) => z.type === "BSL" && z.status === "ACTIVE" && z.level > entry)
                .sort((a, b) => a.level - b.level)[0];
        if (inducer) {
          components.inducement = {
            detected: true,
            detail: `${direction === "LONG" ? "Sell" : "Buy"}-side liquidity at ${inducer.level.toFixed(2)} may induce premature entries before the intended POI.`,
          };
        }
      }
    }
    return components;
  }

  private computeTargets(
    direction: Direction,
    entry: number,
    risk: number,
    snapshots: Record<Timeframe, TimeframeSnapshot | undefined>,
  ): { targets: number[]; reasons: string[] } {
    const liqType = direction === "LONG" ? "BSL" : "SSL";
    const levels: number[] = [];
    for (const tf of [this.cfg.timeframes.ltf, this.cfg.timeframes.mtf, this.cfg.timeframes.htf]) {
      const snap = snapshots[tf];
      if (!snap) continue;
      for (const z of snap.liquidityZones) {
        if (z.type !== liqType) continue;
        if (direction === "LONG" && z.level > entry + risk) levels.push(z.level);
        if (direction === "SHORT" && z.level < entry - risk) levels.push(z.level);
      }
    }
    levels.sort((a, b) => (direction === "LONG" ? a - b : b - a));
    const unique = [...new Set(levels.map((l) => Math.round(l * 100) / 100))];

    const swingTargets: number[] = [];
    for (const tf of [this.cfg.timeframes.ltf, this.cfg.timeframes.mtf]) {
      const snap = snapshots[tf];
      if (!snap) continue;
      if (direction === "LONG" && snap.structure.lastSwingHigh) {
        swingTargets.push(snap.structure.lastSwingHigh.price);
      }
      if (direction === "SHORT" && snap.structure.lastSwingLow) {
        swingTargets.push(snap.structure.lastSwingLow.price);
      }
    }

    const minRr = this.cfg.minRr;
    const targets: number[] = [];
    const reasons: string[] = [];

    const liquidityTargets = unique.filter((l) => {
      if (direction === "LONG") return l > entry;
      return l < entry;
    });

    if (liquidityTargets.length >= 1) {
      targets.push(liquidityTargets[0]);
      reasons.push("TP1: nearest opposing buy-side liquidity.");
    }
    if (liquidityTargets.length >= 2) {
      targets.push(liquidityTargets[1]);
      reasons.push("TP2: next opposing liquidity pool.");
    } else if (swingTargets.length > 0) {
      const next = direction === "LONG"
        ? swingTargets.filter((s) => s > (targets[targets.length - 1] ?? entry)).sort((a, b) => a - b)[0]
        : swingTargets.filter((s) => s < (targets[targets.length - 1] ?? entry)).sort((a, b) => b - a)[0];
      if (next !== undefined) {
        targets.push(next);
        reasons.push("TP2: external structural swing.");
      }
    }

    // Final RR-based target beyond TP1/TP2
    const lastTarget = targets[targets.length - 1];
    const rrToLast = lastTarget ? Math.abs(lastTarget - entry) / risk : 0;
    const finalRr = Math.max(minRr, rrToLast + 1);
    const finalTarget = direction === "LONG" ? entry + finalRr * risk : entry - finalRr * risk;
    if (finalTarget !== lastTarget && finalTarget !== targets[targets.length - 2]) {
      targets.push(finalTarget);
      reasons.push(`TP3: projected reward of 1:${finalRr.toFixed(1)}.`);
    }

    return { targets, reasons };
  }

  private atrAt(tf: Timeframe): number {
    const buf = this.candles[tf];
    if (!buf || buf.length < 16) return 0;
    const values = atr(buf, 14);
    const last = values[values.length - 1];
    return Number.isFinite(last) ? last : 0;
  }

  // ------------------------------------------------------------------
  // Quality / hard-rule evaluation
  // ------------------------------------------------------------------

  private evaluateQuality(
    setup: Setup,
    td: ReturnType<typeof topDownAnalysis>,
    snapshots: Record<Timeframe, TimeframeSnapshot | undefined>,
  ): {
    score: number;
    factors: Setup["qualityFactors"];
    hardRules: Setup["qualityFactors"];
    rejections: string[];
  } {
    const ltfSnap = snapshots[this.cfg.timeframes.ltf];
    const mtfSnap = snapshots[this.cfg.timeframes.mtf];
    const rejections: string[] = [];
    const hardRules: ConfluenceFactor[] = [];
    const factors: ConfluenceFactor[] = [];
    const long = setup.direction === "LONG";

    // Hard rule: HTF bias aligned
    const htfAligned =
      (long && (td.bias === "BULLISH" || td.bias === "NEUTRAL")) ||
      (!long && (td.bias === "BEARISH" || td.bias === "NEUTRAL"));
    hardRules.push({
      name: "HTF bias",
      status: htfAligned ? "PASS" : "FAIL",
      detail: htfAligned
        ? `${long ? "Bullish" : "Bearish"} higher-timeframe bias.`
        : `Higher-timeframe bias is ${td.bias === "NEUTRAL" ? "neutral" : "opposing"}.`,
    });
    if (!htfAligned && !setup.counterTrend) {
      rejections.push(`Higher-timeframe bias is ${td.bias === "NEUTRAL" ? "neutral/unclear" : "opposing"}.`);
    }

    // Hard rule: POI valid
    hardRules.push({
      name: "POI",
      status: "PASS",
      detail: `Price is at a valid ${setup.components.poi?.kind ?? "POI"}.`,
    });

    // Hard rule: minimum RR
    const minRr = setup.counterTrend
      ? this.cfg.minRr * this.cfg.counterTrendMinRrMultiplier
      : this.cfg.minRr;
    const rr0 = setup.rr[0] ?? 0;
    const rrOk = rr0 >= minRr;
    hardRules.push({
      name: "RR",
      status: rrOk ? "PASS" : "FAIL",
      detail: rrOk
        ? `RR = 1:${rr0.toFixed(1)} meets the 1:${minRr} minimum.`
        : `RR = 1:${rr0.toFixed(1)} is below the 1:${minRr} minimum.`,
    });
    if (!rrOk) {
      rejections.push(`RR = 1:${rr0.toFixed(1)} is below the required 1:${minRr}.`);
    }

    // Hard rule: entry model conditions
    let modelPass = false;
    let modelDetail = "";
    if (ltfSnap && mtfSnap) {
      if (setup.entryModel === "AGGRESSIVE") {
        modelPass = td.alignment >= 2 && td.conflict === null && rrOk;
        modelDetail = modelPass
          ? "Aggressive entry: aligned timeframes and valid POI without lower-timeframe confirmation."
          : td.conflict !== null
            ? "Aggressive entry requires aligned timeframes; a lower-timeframe conflict exists."
            : "Aggressive entry requires multi-timeframe alignment.";
      } else if (setup.entryModel === "CONFIRMATION") {
        const chochOk = ltfSnap.choch.some((c) =>
          long ? c.direction === "BULLISH" : c.direction === "BEARISH",
        );
        const ltfTrendOk = long ? ltfSnap.structure.trend === "BULLISH" : ltfSnap.structure.trend === "BEARISH";
        modelPass = chochOk || (ltfTrendOk && rrOk);
        modelDetail = chochOk
          ? "Lower-timeframe CHoCH confirmed."
          : ltfTrendOk
            ? "Lower-timeframe trend supports the setup."
            : "Waiting for lower-timeframe CHoCH confirmation.";
        if (!chochOk) {
          rejections.push("Lower-timeframe CHoCH has not been confirmed.");
        }
      } else if (setup.entryModel === "SWEEP") {
        const sweep = ltfSnap.sweeps.at(-1);
        const sweepOk = !!sweep && sweep.rejected;
        const chochOk = ltfSnap.choch.some((c) =>
          long ? c.direction === "BULLISH" : c.direction === "BEARISH",
        );
        modelPass = sweepOk && chochOk && rrOk;
        if (!sweepOk) rejections.push("No recent confirmed liquidity sweep with rejection.");
        if (!chochOk) rejections.push("No CHoCH after the sweep.");
        modelDetail = modelPass
          ? "Liquidity swept with rejection and structure shift confirmed."
          : "Sweep entry requires a liquidity sweep with rejection followed by a structure shift.";
      } else {
        // COUNTER_TREND
        const chochOk = ltfSnap.choch.some((c) =>
          long ? c.direction === "BULLISH" : c.direction === "BEARISH",
        );
        modelPass = chochOk && td.conflict !== null && rrOk;
        modelDetail = modelPass
          ? "Counter-trend setup: lower-timeframe shift against the higher timeframe with stronger RR requirement."
          : "Counter-trend setups require a confirmed shift against the higher timeframe.";
      }
    }
    hardRules.push({
      name: "Entry model",
      status: modelPass ? "PASS" : "FAIL",
      detail: modelPass ? modelDetail : modelDetail || "Entry model conditions not met.",
    });
    if (!modelPass) {
      rejections.push(modelDetail || "Entry model conditions not met.");
    }

    // Quality factors
    const ltfConfirmed =
      !!ltfSnap && (ltfSnap.choch.some((c) => (long ? c.direction === "BULLISH" : c.direction === "BEARISH")) ||
        (long ? ltfSnap.structure.trend === "BULLISH" : ltfSnap.structure.trend === "BEARISH"));
    factors.push({
      name: "LTF confirmation",
      status: ltfConfirmed ? "PASS" : "NEUTRAL",
      detail: ltfConfirmed ? "Lower timeframe has confirmed the move." : "Lower timeframe has not confirmed.",
    });
    if (td.conflict === null) {
      factors.push({ name: "Timeframe alignment", status: "PASS", detail: "No timeframe conflict." });
    } else {
      factors.push({ name: "Timeframe alignment", status: "NEUTRAL", detail: td.conflict });
    }
    const ob = setup.components.orderBlockId
      ? (ltfSnap?.orderBlocks ?? []).find((o) => o.id === setup.components.orderBlockId)
      : undefined;
    factors.push({
      name: "Order block",
      status: ob ? "PASS" : "NEUTRAL",
      detail: ob ? `Fresh order block (strength ${ob.strength.toFixed(2)}).` : "No fresh order block in the entry zone.",
    });
    const fvg = setup.components.fvgId
      ? (ltfSnap?.fvgs ?? []).find((f) => f.id === setup.components.fvgId)
      : undefined;
    factors.push({
      name: "Fair value gap",
      status: fvg ? "PASS" : "NEUTRAL",
      detail: fvg ? "Fresh fair value gap in the entry zone." : "No fresh fair value gap.",
    });
    if (setup.components.premiumDiscount) {
      const good =
        (long && setup.components.premiumDiscount.position !== "PREMIUM") ||
        (!long && setup.components.premiumDiscount.position !== "DISCOUNT");
      factors.push({
        name: "Premium / discount",
        status: good ? "PASS" : "NEUTRAL",
        detail: describePd(setup.components.premiumDiscount.ratio),
      });
    }
    if (setup.components.sweepEvent) {
      factors.push({
        name: "Liquidity sweep",
        status: setup.components.sweepEvent.rejected ? "PASS" : "NEUTRAL",
        detail: setup.components.sweepEvent.rejected
          ? `${setup.components.sweepEvent.direction === "LONG" ? "Sell" : "Buy"}-side liquidity swept with rejection.`
          : "Liquidity swept without a clean rejection.",
      });
    }
    if (setup.components.targetLiquidity) {
      factors.push({
        name: "Target liquidity",
        status: "PASS",
        detail: `Target liquidity at ${setup.components.targetLiquidity.level.toFixed(2)}.`,
      });
    }
    if (setup.components.inducement?.detected) {
      factors.push({
        name: "Inducement",
        status: "NEUTRAL",
        detail: setup.components.inducement.detail,
      });
    }

    const hardOk = hardRules.every((h) => h.status === "PASS");
    const quality = scoreSetup({
      alignment: td.alignment,
      ht: td.htf.strength,
      poiStrength: setup.components.poi?.strength ?? 0.5,
      poiStatus: setup.components.poi?.status ?? "FRESH",
      fvgFresh: !!fvg,
      obFresh: !!ob,
      sweepQuality: setup.components.sweepEvent ? (setup.components.sweepEvent.rejected ? 1 : 0.5) : 0,
      discountDepth:
        setup.components.premiumDiscount?.position === "DISCOUNT"
          ? 1 - setup.components.premiumDiscount.ratio
          : setup.components.premiumDiscount?.position === "PREMIUM"
            ? setup.components.premiumDiscount.ratio
            : 0.5,
      momentumScore: ltfSnap ? (setup.components.momentum?.score ?? 0.5) : 0.5,
      rrDepth: Math.min(1, rr0 / (minRr * 1.5)),
      targetLiquidity: setup.components.targetLiquidity ? 1 : 0,
      chochConfirmed: ltfConfirmed,
    });

    return {
      score: hardOk ? quality.score : Math.min(quality.score, 70),
      factors,
      hardRules,
      rejections: rejections.length ? [...new Set(rejections)] : [],
    };
  }

  private resolveSetupStatus(
    setup: Setup,
    quality: ReturnType<typeof this.evaluateQuality>,
  ): Setup["status"] {
    if (quality.rejections.length > 0) return "REJECTED";
    if (quality.hardRules.some((h) => h.status === "FAIL")) return "REJECTED";
    return "VALID";
  }

  /** Recent POI/liquidity context used by the strategy layer */
  context(price: number): {
    ht: "STRONG" | "WEAK";
    lastSweep?: SweepEvent;
    lastChoch?: ChochEvent;
    bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCLEAR";
  } {
    const snapshots = this.buildSnapshots();
    const ltfSnap = snapshots[this.cfg.timeframes.ltf];
    const td = this.analyzeTopDownOnly();
    return {
      ht: ltfSnap?.structure.strength ?? "WEAK",
      lastSweep: ltfSnap?.sweeps.at(-1),
      lastChoch: ltfSnap?.choch.at(-1),
      bias: td?.bias ?? "UNCLEAR",
    };
  }

  private analyzeTopDownOnly(): ReturnType<typeof topDownAnalysis> | null {
    const htf = this.cfg.timeframes.htf;
    const mtf = this.cfg.timeframes.mtf;
    const ltf = this.cfg.timeframes.ltf;
    const htfSnap = this.engines[htf]?.structure.snapshot();
    const mtfSnap = this.engines[mtf]?.structure.snapshot();
    const ltfSnap = this.engines[ltf]?.structure.snapshot();
    return htfSnap && mtfSnap && ltfSnap
      ? topDownAnalysis(
          snapshotToBias(htfSnap, htf),
          snapshotToBias(mtfSnap, mtf),
          snapshotToBias(ltfSnap, ltf),
        )
      : null;
  }
}

export type { SetupQuality };
