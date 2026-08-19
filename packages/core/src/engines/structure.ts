import type { Candle, Timeframe, Trend } from "../types/candles.js";
import type {
  BosEvent,
  ChochEvent,
  MarketStructureState,
  StructureClass,
  StructurePoint,
  StructurePointKind,
  StructureSnapshot,
} from "../types/structure.js";
import { detectSwings } from "./swing.js";

const EPS = 1e-12;

export interface StructureEngineOptions {
  strength: number;
  lookback: number;
  maxHistory: number;
}

export interface StructureUpdateResult {
  state: MarketStructureState;
  bos: BosEvent[];
  choch: ChochEvent[];
  snapshot: StructureSnapshot;
}

export class MarketStructureEngine {
  readonly symbol: string;
  readonly exchange: string;
  readonly timeframe: Timeframe;
  private candles: Candle[] = [];
  private points: StructurePoint[] = [];
  private trend: Trend = "NEUTRAL";
  private bosEvents: BosEvent[] = [];
  private chochEvents: ChochEvent[] = [];
  private opts: StructureEngineOptions;
  private lastBreakKey = "";
  private lastEventIndex = -1;

  constructor(
    symbol: string,
    exchange: string,
    timeframe: Timeframe,
    opts?: Partial<StructureEngineOptions>,
  ) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = {
      strength: opts?.strength ?? 2,
      lookback: opts?.lookback ?? 300,
      maxHistory: opts?.maxHistory ?? 3000,
    };
  }

  update(candle: Candle): void {
    if (
      this.candles.length > 0 &&
      candle.timestamp <= this.candles[this.candles.length - 1].timestamp
    ) {
      return;
    }
    this.candles.push(candle);
    if (this.candles.length > this.opts.maxHistory) {
      this.candles.splice(0, this.candles.length - this.opts.maxHistory);
    }
    this.recompute();
  }

  private recompute(): void {
    const candles = this.candles;
    const n = candles.length;
    const window = candles.slice(-this.opts.lookback);

    const swings = detectSwings(window, { strength: this.opts.strength });

    const points: StructurePoint[] = [];
    let lastHigh: StructurePoint | undefined;
    let lastLow: StructurePoint | undefined;

    for (const sw of swings) {
      let kind: StructurePointKind;
      let external = false;
      const candleIndex = n - window.length + sw.index;
      if (sw.kind === "HIGH") {
        kind = lastHigh
          ? sw.price > lastHigh.price + EPS
            ? "HH"
            : "LH"
          : "SWING_HIGH";
        external = lastHigh ? sw.price > lastHigh.price + EPS : false;
        lastHigh = {
          index: candleIndex,
          timestamp: sw.timestamp,
          price: sw.price,
          kind,
          external,
          createdAt: sw.timestamp,
        };
        points.push(lastHigh);
      } else {
        kind = lastLow
          ? sw.price > lastLow.price + EPS
            ? "HL"
            : "LL"
          : "SWING_LOW";
        external = lastLow ? sw.price > lastLow.price + EPS : false;
        lastLow = {
          index: candleIndex,
          timestamp: sw.timestamp,
          price: sw.price,
          kind,
          external,
          createdAt: sw.timestamp,
        };
        points.push(lastLow);
      }
    }

    this.points = points;
    this.updateTrend();
  }

  private updateTrend(): void {
    const lows = this.points.filter((p) => p.kind.endsWith("L") || p.kind === "SWING_LOW");
    const highs = this.points.filter((p) => p.kind.endsWith("H") || p.kind === "SWING_HIGH");
    const lowKinds = lows.map((p) => p.kind);
    const highKinds = highs.map((p) => p.kind);
    const lastLowKinds = lowKinds.slice(-3);
    const lastHighKinds = highKinds.slice(-3);

    const lowsUp = lastLowKinds.filter((k) => k === "HL").length >= 2;
    const lowsDown = lastLowKinds.filter((k) => k === "LL").length >= 2;
    const highsUp = lastHighKinds.filter((k) => k === "HH").length >= 2;
    const highsDown = lastHighKinds.filter((k) => k === "LH").length >= 2;

    if ((lowsUp || highsUp) && !lowsDown && !highsDown) {
      this.trend = "BULLISH";
    } else if ((lowsDown || highsDown) && !lowsUp && !highsUp) {
      this.trend = "BEARISH";
    } else if (lowsUp && lowsDown) {
      this.trend = "RANGING";
    } else {
      this.trend = this.points.length < 4 ? "NEUTRAL" : "RANGING";
    }
  }

  /**
   * Detect BOS / CHoCH on the most recent candle close. Must be called after
   * update() with the same candle. Deterministic given the same history.
   */
  evaluate(): StructureUpdateResult {
    const events: BosEvent[] = [];
    const choch: ChochEvent[] = [];
    const n = this.candles.length;
    if (n < 2) {
      return { state: this.toState(), bos: events, choch, snapshot: this.snapshot() };
    }

    const last = this.candles[n - 1];
    const close = last.close;
    const lastHigh = this.points.filter((p) => p.kind.endsWith("H") || p.kind === "SWING_HIGH").at(-1);
    const lastLow = this.points.filter((p) => p.kind.endsWith("L") || p.kind === "SWING_LOW").at(-1);

    const prevTrend = this.trend;

    if (lastHigh && close > lastHigh.price + EPS) {
      const key = `BOS_UP_${lastHigh.price.toFixed(8)}_${(n - 1)}`;
      if (key !== this.lastBreakKey || n - 1 > this.lastEventIndex + 60) {
        this.lastBreakKey = key;
        this.lastEventIndex = n - 1;
        events.push({
          type: "BOS_CONFIRMED",
          symbol: this.symbol,
          exchange: this.exchange,
          timeframe: this.timeframe,
          direction: "BULLISH",
          brokenLevel: lastHigh.price,
          confirmationPrice: close,
          candleIndex: n - 1,
          timestamp: last.timestamp,
          strength: prevTrend === "BULLISH" ? "STRONG" : "WEAK",
          previousStructure: prevTrend,
          resultingStructure: "BULLISH",
        });
      }
    }

    if (lastLow && close < lastLow.price - EPS) {
      const key = `BOS_DOWN_${lastLow.price.toFixed(8)}_${(n - 1)}`;
      if (key !== this.lastBreakKey || n - 1 > this.lastEventIndex + 60) {
        this.lastBreakKey = key;
        this.lastEventIndex = n - 1;
        events.push({
          type: "BOS_CONFIRMED",
          symbol: this.symbol,
          exchange: this.exchange,
          timeframe: this.timeframe,
          direction: "BEARISH",
          brokenLevel: lastLow.price,
          confirmationPrice: close,
          candleIndex: n - 1,
          timestamp: last.timestamp,
          strength: prevTrend === "BEARISH" ? "STRONG" : "WEAK",
          previousStructure: prevTrend,
          resultingStructure: "BEARISH",
        });
      }
    }

    if (prevTrend === "BULLISH" && lastLow && close < lastLow.price - EPS) {
      const sweepish = this.levelWasSwept(lastLow.price, "BEARISH", (n - 1));
      choch.push({
        type: "CHOCH",
        symbol: this.symbol,
        exchange: this.exchange,
        timeframe: this.timeframe,
        direction: "BEARISH",
        brokenLevel: lastLow.price,
        confirmationPrice: close,
        candleIndex: n - 1,
        timestamp: last.timestamp,
        status: "CONFIRMED",
        causedBySweep: sweepish,
        previousTrend: "BULLISH",
        resultingTrend: "BEARISH",
      });
    } else if (prevTrend === "BEARISH" && lastHigh && close > lastHigh.price + EPS) {
      const sweepish = this.levelWasSwept(lastHigh.price, "BULLISH", (n - 1));
      choch.push({
        type: "CHOCH",
        symbol: this.symbol,
        exchange: this.exchange,
        timeframe: this.timeframe,
        direction: "BULLISH",
        brokenLevel: lastHigh.price,
        confirmationPrice: close,
        candleIndex: n - 1,
        timestamp: last.timestamp,
        status: "CONFIRMED",
        causedBySweep: sweepish,
        previousTrend: "BEARISH",
        resultingTrend: "BULLISH",
      });
    }

    this.bosEvents.push(...events);
    this.chochEvents.push(...choch);

    return { state: this.toState(), bos: events, choch, snapshot: this.snapshot() };
  }

  /** true when price wick-traded beyond level (in direction) before the current close */
  private levelWasSwept(level: number, direction: "BULLISH" | "BEARISH", toIndex: number): boolean {
    const start = Math.max(0, toIndex - 5);
    for (let i = start; i < toIndex; i++) {
      const c = this.candles[i];
      if (!c) continue;
      if (direction === "BULLISH" && c.high > level + EPS && c.close <= level + EPS) return true;
      if (direction === "BEARISH" && c.low < level - EPS && c.close >= level - EPS) return true;
    }
    return false;
  }

  get lastBosEvents(): BosEvent[] {
    return this.bosEvents.slice(-5);
  }

  get lastChochEvents(): ChochEvent[] {
    return this.chochEvents.slice(-5);
  }

  toState(): MarketStructureState {
    const lastHigh = this.points.filter((p) => p.kind.endsWith("H") || p.kind === "SWING_HIGH").at(-1);
    const lastLow = this.points.filter((p) => p.kind.endsWith("L") || p.kind === "SWING_LOW").at(-1);
    const strong =
      this.points.filter((p) => (p.kind === "HH" || p.kind === "HL") && p.external).length +
        this.points.filter((p) => (p.kind === "LH" || p.kind === "LL") && p.external).length >=
      4;
    return {
      symbol: this.symbol,
      exchange: this.exchange,
      timeframe: this.timeframe,
      points: this.points.slice(-40),
      trend: this.trend,
      strength: strong ? "STRONG" : "WEAK",
      lastSwingHigh: lastHigh,
      lastSwingLow: lastLow,
      updatedAt: this.candles.length ? this.candles[this.candles.length - 1].timestamp : 0,
    };
  }

  snapshot(): StructureSnapshot {
    const state = this.toState();
    const highs = state.points.filter((p) => p.kind.endsWith("H"));
    const lows = state.points.filter((p) => p.kind.endsWith("L"));
    return {
      trend: state.trend,
      strength: state.strength,
      sequence: [
        ...highs.slice(-2).map((p) => p.kind),
        ...lows.slice(-2).map((p) => p.kind),
      ],
      lastSwingHigh: state.lastSwingHigh
        ? { price: state.lastSwingHigh.price, timestamp: state.lastSwingHigh.timestamp }
        : undefined,
      lastSwingLow: state.lastSwingLow
        ? { price: state.lastSwingLow.price, timestamp: state.lastSwingLow.timestamp }
        : undefined,
    };
  }

  getState(): MarketStructureState {
    return this.toState();
  }

  get candlesCount(): number {
    return this.candles.length;
  }
}

export type { StructureClass };
