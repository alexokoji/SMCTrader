/**
 * Real Smart Money analysis runtime for the Cloudflare Worker.
 *
 * This module replaces the placeholder moving-average signal that previously
 * ran in the Durable Object. Every published bias, setup, rejection and paper
 * order now comes from the deterministic engine in `@smc/core`, so the values
 * the dashboard shows are the values the strategy actually produced.
 *
 * CPU budget
 * ----------
 * Feeding a full candle history costs roughly 60-100ms of CPU, which exceeds
 * the 10ms-per-invocation ceiling on Cloudflare's free plan. A steady-state
 * `analyze()` costs 0.5-1.5ms. The runtime therefore keeps engines warm in
 * Durable Object memory and, after an eviction, replays stored candles in
 * bounded chunks across successive ticks instead of in a single invocation.
 */
import {
  AnalysisEngine,
  MultiExchangeMarketData,
  StrategyEngine,
  DEFAULT_RISK_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  TIMEFRAME_DURATION_MS,
  validateRiskConfig,
  type Candle,
  type RiskConfig,
  type StrategyConfig,
  type StrategyEngineSnapshot,
  type SymbolAnalysis,
  type Timeframe,
  type TradingMode,
} from "@smc/core";

/** Candles retained per timeframe. Bounds both storage and replay cost. */
export const CANDLE_BUFFER = 240;

/** Maximum candles replayed per invocation while warming a cold engine. */
export const HYDRATION_BUDGET = 90;

export interface RuntimeStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
}

export interface SymbolState {
  engine: StrategyEngine;
  /** Newest candle timestamp fed per timeframe, used for incremental feeding. */
  fedThrough: Partial<Record<Timeframe, number>>;
  /** True once the stored history has been fully replayed into the engine. */
  warm: boolean;
}

export interface AnalysisTick {
  symbol: string;
  exchange: string;
  status: string;
  warming: boolean;
  analysis: SymbolAnalysis;
  executed: number;
  rejected: number;
  message?: string;
}

function candleKey(symbol: string, tf: Timeframe): string {
  return `candles:${symbol}:${tf}`;
}

function snapshotKey(symbol: string): string {
  return `engine:${symbol}`;
}

/** Merge freshly fetched candles into a stored buffer, de-duplicating by open time. */
export function mergeCandles(stored: Candle[], incoming: Candle[]): Candle[] {
  const byTimestamp = new Map<number, Candle>();
  for (const candle of stored) byTimestamp.set(candle.timestamp, candle);
  // Incoming candles win: the newest fetch re-states the most recent bar, which
  // may have closed since it was last stored.
  for (const candle of incoming) byTimestamp.set(candle.timestamp, candle);
  return [...byTimestamp.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-CANDLE_BUFFER);
}

/**
 * Drop the most recent candle when it has not closed yet. The engine must never
 * analyse a forming bar: doing so produces structure that changes retroactively.
 */
export function closedCandlesOnly(candles: Candle[], tfDurationMs: number, now: number): Candle[] {
  return candles.filter((candle) => candle.timestamp + tfDurationMs <= now);
}

const TF_MS = TIMEFRAME_DURATION_MS;

export class TradingRuntime {
  private readonly storage: RuntimeStorage;
  private readonly marketData: MultiExchangeMarketData;
  private readonly symbols = new Map<string, SymbolState>();
  private lastProvider = "unknown";

  constructor(storage: RuntimeStorage, opts: { fetchFn?: typeof fetch } = {}) {
    this.storage = storage;
    this.marketData = new MultiExchangeMarketData({
      fetchFn: opts.fetchFn,
      timeoutMs: 8_000,
    });
  }

  get provider(): string {
    return this.lastProvider;
  }

  strategyConfigFor(symbol: string, overrides?: Partial<StrategyConfig>): StrategyConfig {
    return {
      ...DEFAULT_STRATEGY_CONFIG,
      ...overrides,
      symbol,
      exchange: "multi-exchange",
    };
  }

  /**
   * Fetch new candles for every configured timeframe and persist them. Returns
   * the merged, stored buffers so a caller can replay them into the engine.
   */
  async refreshCandles(
    symbol: string,
    timeframes: { htf: Timeframe; mtf: Timeframe; ltf: Timeframe },
    now: number,
  ): Promise<Record<Timeframe, Candle[]>> {
    const unique = [...new Set([timeframes.htf, timeframes.mtf, timeframes.ltf])];
    const buffers = {} as Record<Timeframe, Candle[]>;
    const writes: Record<string, unknown> = {};

    for (const tf of unique) {
      const stored = (await this.storage.get<Candle[]>(candleKey(symbol, tf))) ?? [];
      const newestStored = stored.at(-1)?.timestamp ?? 0;
      // Only request the window we are missing. A warm engine fetches a handful
      // of bars; a cold one backfills the whole buffer once.
      const span = TF_MS[tf] * CANDLE_BUFFER;
      const startTime = newestStored > 0 ? newestStored : now - span;
      let fetched: Candle[] = [];
      try {
        fetched = await this.marketData.getOHLCV(symbol, tf, startTime, now, CANDLE_BUFFER);
        this.lastProvider = fetched[0]?.exchange ?? this.lastProvider;
      } catch (error) {
        // A provider outage must not discard history we already hold.
        if (!stored.length) throw error;
      }
      const merged = mergeCandles(stored, fetched);
      buffers[tf] = closedCandlesOnly(merged, TF_MS[tf], now);
      writes[candleKey(symbol, tf)] = merged;
    }

    await this.storage.put(writes);
    return buffers;
  }

  /**
   * Run one analysis tick for a symbol. Creates the engine if needed, replays
   * any outstanding history within the hydration budget, feeds new candles and
   * returns the resulting analysis.
   */
  async tick(
    symbol: string,
    opts: {
      mode: TradingMode;
      risk: Partial<RiskConfig>;
      strategy?: Partial<StrategyConfig>;
      autoTrading: boolean;
      safetyBlocked: boolean;
      now?: number;
    },
  ): Promise<AnalysisTick> {
    const now = opts.now ?? Date.now();
    const strategyCfg = this.strategyConfigFor(symbol, opts.strategy);
    const riskCfg = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, ...opts.risk });

    let state = this.symbols.get(symbol);
    if (!state) {
      const engine = new StrategyEngine({
        strategy: strategyCfg,
        risk: riskCfg,
        mode: opts.mode,
        analysis: new AnalysisEngine(symbol, "multi-exchange", strategyCfg),
      });
      const snapshot = await this.storage.get<StrategyEngineSnapshot>(snapshotKey(symbol));
      if (snapshot) {
        try {
          engine.restore(snapshot);
        } catch {
          // A snapshot from an older engine version is discarded rather than
          // silently mixed into current state.
        }
      }
      state = { engine, fedThrough: {}, warm: false };
      this.symbols.set(symbol, state);
    }

    const engine = state.engine;
    engine.setMode(opts.mode);
    engine.updateRiskConfig(riskCfg);
    if (engine.isAutoTrading() !== opts.autoTrading) engine.setAutoTrading(opts.autoTrading);
    if (opts.safetyBlocked && !engine.isSafetyBlocked()) engine.enterSafeMode("Safety stop is engaged.");
    if (!opts.safetyBlocked && engine.isSafetyBlocked()) engine.exitSafeMode();

    const buffers = await this.refreshCandles(symbol, strategyCfg.timeframes, now);

    // Interleave timeframes in chronological order so structure on each
    // timeframe advances together, exactly as it would in a live feed.
    const pending = Object.values(buffers)
      .flat()
      .filter((candle) => candle.timestamp > (state!.fedThrough[candle.timeframe] ?? 0))
      .sort((a, b) => a.timestamp - b.timestamp);

    const budgeted = pending.slice(0, HYDRATION_BUDGET);
    const warming = budgeted.length < pending.length;

    let executed = 0;
    let rejected = 0;
    let message: string | undefined;

    for (const candle of budgeted) {
      const result = engine.onCandleClosed(candle);
      state.fedThrough[candle.timeframe] = candle.timestamp;
      executed += result.decisions.filter((d) => d.decision === "EXECUTE").length;
      rejected += result.rejectedSetups.length;
      message = result.message ?? message;
    }
    await engine.flush();

    // Mark open positions against the newest close so stops and targets are
    // evaluated on every tick, not only when a setup appears.
    const ltfBuffer = buffers[strategyCfg.timeframes.ltf] ?? [];
    const lastBar = ltfBuffer.at(-1);
    if (lastBar) engine.onPriceBar(symbol, lastBar, lastBar.timestamp);

    state.warm = !warming && pending.length === budgeted.length;

    const analysis = engine.analysis.analyze();
    await this.persist(symbol, engine);

    return {
      symbol,
      exchange: this.lastProvider,
      status: warming ? "WARMING_UP" : analysis.status,
      warming,
      analysis,
      executed,
      rejected,
      message: warming
        ? `Replaying stored history: ${pending.length - budgeted.length} candles remaining before analysis is authoritative.`
        : message,
    };
  }

  private async persist(symbol: string, engine: StrategyEngine): Promise<void> {
    await this.storage.put({ [snapshotKey(symbol)]: engine.serialize() });
  }

  engineFor(symbol: string): StrategyEngine | undefined {
    return this.symbols.get(symbol)?.engine;
  }
}
