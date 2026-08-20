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

/**
 * Candles replayed per invocation. Because a rebuilt engine always replays from
 * the start, this is set to cover a full buffer for all three timeframes in one
 * invocation, so an engine is usable immediately rather than after N alarms.
 */
export const HYDRATION_BUDGET = 800;

/**
 * Alarm delay while an engine still has history to replay. Warm-up is bounded
 * by CPU per invocation, not by wall-clock, so the fastest safe way through it
 * is many small invocations rather than fewer large ones.
 */
export const WARMING_TICK_MS = 20_000;

/** Slowest interval at which an unchanged engine snapshot is still persisted. */
export const SNAPSHOT_HEARTBEAT_MS = 10 * 60_000;

/** Alarm delay once the engine is caught up and only needs new closed bars. */
export const STEADY_TICK_MS = 5 * 60_000;

export interface RuntimeStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
}

export interface SymbolState {
  engine: StrategyEngine;
  /** Signature of the last persisted snapshot, to skip unchanged writes. */
  lastSnapshotSignature?: string;
  lastPersistAt?: number;
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
  /** How long the caller should wait before the next tick for this symbol. */
  nextTickMs: number;
  /** True when this tick replayed stored history instead of calling an exchange. */
  usedStoredHistory: boolean;
  analysis: SymbolAnalysis;
  executed: number;
  rejected: number;
  /** Why the execution path declined a setup, so a READY market that never
   * trades can be explained rather than guessed at. */
  blockedReasons: string[];
  message?: string;
}

function candleKey(symbol: string, tf: Timeframe): string {
  return `candles:${symbol}:${tf}`;
}

function snapshotKey(symbol: string): string {
  return `engine:${symbol}`;
}

/**
 * What is persisted under the engine key.
 *
 * Only execution and risk state is stored. Replay progress deliberately is not:
 * the analysis engine's candle buffers live in memory and are rebuilt purely by
 * replaying, so a restored watermark on a freshly built engine would mark an
 * empty engine as warm and it would never load a single candle.
 */
interface PersistedEngine {
  snapshot: StrategyEngineSnapshot;
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

  private readonly hydrationBudget: number;

  constructor(storage: RuntimeStorage, opts: { fetchFn?: typeof fetch; hydrationBudget?: number } = {}) {
    this.storage = storage;
    this.hydrationBudget = opts.hydrationBudget ?? HYDRATION_BUDGET;
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

  /** Read the stored candle buffers without contacting an exchange. */
  async storedBuffers(
    symbol: string,
    timeframes: { htf: Timeframe; mtf: Timeframe; ltf: Timeframe },
    now: number,
  ): Promise<Record<Timeframe, Candle[]>> {
    const unique = [...new Set([timeframes.htf, timeframes.mtf, timeframes.ltf])];
    const buffers = {} as Record<Timeframe, Candle[]>;
    for (const tf of unique) {
      const stored = (await this.storage.get<Candle[]>(candleKey(symbol, tf))) ?? [];
      buffers[tf] = closedCandlesOnly(stored, TF_MS[tf], now);
    }
    return buffers;
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
      // Only write when the buffer actually changed. Each timeframe is its own
      // storage row, and rewriting identical buffers every tick was a large
      // share of the write budget.
      const changed =
        merged.length !== stored.length ||
        merged.at(-1)?.timestamp !== stored.at(-1)?.timestamp ||
        merged.at(-1)?.close !== stored.at(-1)?.close;
      if (changed) writes[candleKey(symbol, tf)] = merged;
    }

    if (Object.keys(writes).length > 0) await this.storage.put(writes);
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
      const stored = await this.storage.get<PersistedEngine | StrategyEngineSnapshot>(snapshotKey(symbol));
      // Older deployments stored the bare snapshot under this key.
      const persisted: PersistedEngine | undefined = stored
        ? ("snapshot" in stored ? (stored as PersistedEngine) : { snapshot: stored as StrategyEngineSnapshot })
        : undefined;
      if (persisted?.snapshot) {
        try {
          engine.restore(persisted.snapshot);
        } catch {
          // A snapshot from an older engine version is discarded rather than
          // silently mixed into current state.
        }
      }
      // Always replay from the start of the stored buffer: a new engine has no
      // candles, whatever a previous invocation had already fed.
      state = { engine, fedThrough: {}, warm: false };
      this.symbols.set(symbol, state);
    }

    const engine = state.engine;
    engine.setMode(opts.mode);
    engine.updateRiskConfig(riskCfg);
    if (engine.isAutoTrading() !== opts.autoTrading) engine.setAutoTrading(opts.autoTrading);
    if (opts.safetyBlocked && !engine.isSafetyBlocked()) engine.enterSafeMode("Safety stop is engaged.");
    if (!opts.safetyBlocked && engine.isSafetyBlocked()) engine.exitSafeMode();

    const backlogOf = (buffers: Record<Timeframe, Candle[]>) =>
      Object.values(buffers)
        .flat()
        .filter((candle) => candle.timestamp > (state!.fedThrough[candle.timeframe] ?? 0))
        .sort((a, b) => a.timestamp - b.timestamp);

    // Replaying stored history needs no network. Only call an exchange once the
    // backlog is small enough that this tick can also absorb new bars, which
    // keeps warm-up off the exchange rate limits and much faster.
    let buffers = await this.storedBuffers(symbol, strategyCfg.timeframes, now);
    let usedStoredHistory = true;
    if (backlogOf(buffers).length < this.hydrationBudget) {
      buffers = await this.refreshCandles(symbol, strategyCfg.timeframes, now);
      usedStoredHistory = false;
    }

    // Interleave timeframes in chronological order so structure on each
    // timeframe advances together, exactly as it would in a live feed.
    const pending = backlogOf(buffers);

    const budgeted = pending.slice(0, this.hydrationBudget);
    const warming = budgeted.length < pending.length;

    let executed = 0;
    let rejected = 0;
    let message: string | undefined;
    const blocked = new Set<string>();

    for (const candle of budgeted) {
      const result = engine.onCandleClosed(candle);
      state.fedThrough[candle.timeframe] = candle.timestamp;
      executed += result.decisions.filter((d) => d.decision === "EXECUTE").length;
      rejected += result.rejectedSetups.length;
      for (const decision of result.decisions) {
        if (decision.decision === "REJECT") for (const reason of decision.reasons) blocked.add(reason);
      }
      message = result.message ?? message;
    }
    const ltfBuffer = buffers[strategyCfg.timeframes.ltf] ?? [];
    const lastBar = ltfBuffer.at(-1);

    // A tick usually feeds nothing: the alarm runs every five minutes while a
    // lower-timeframe bar closes every fifteen. The decision pipeline only ran
    // inside the candle loop, so a setup that became valid on the last bar was
    // analysed as READY on every later tick and never acted on. Re-run the
    // pipeline against the current price when no candle arrived.
    if (budgeted.length === 0 && lastBar) {
      const result = engine.reevaluate(lastBar.close);
      executed += result.decisions.filter((d) => d.decision === "EXECUTE").length;
      rejected += result.rejectedSetups.length;
      for (const decision of result.decisions) {
        if (decision.decision === "REJECT") for (const reason of decision.reasons) blocked.add(reason);
      }
      message = result.message ?? message;
    }

    await engine.flush();

    // Mark open positions against the newest close so stops and targets are
    // evaluated on every tick, not only when a setup appears.
    if (lastBar) engine.onPriceBar(symbol, lastBar, lastBar.timestamp);

    state.warm = !warming && pending.length === budgeted.length;

    const analysis = engine.analysis.analyze();
    await this.persist(symbol, engine);

    return {
      symbol,
      exchange: this.lastProvider,
      status: warming ? "WARMING_UP" : analysis.status,
      warming,
      nextTickMs: warming ? WARMING_TICK_MS : STEADY_TICK_MS,
      usedStoredHistory,
      analysis,
      executed,
      rejected,
      blockedReasons: [...blocked].slice(-6),
      message: warming
        ? `Replaying stored history: ${pending.length - budgeted.length} candles remaining before analysis is authoritative.`
        : message,
    };
  }

  /**
   * Snapshots exist so an evicted Durable Object can resume without losing
   * positions or the audit trail. They are large, so they are written when that
   * state changes and otherwise at a slow heartbeat, rather than every tick.
   */
  private async persist(symbol: string, engine: StrategyEngine): Promise<void> {
    const snapshot = engine.serialize();
    const signature = [
      snapshot.positions.length,
      snapshot.journal.length,
      snapshot.activity.length,
      snapshot.risk.equity.toFixed(6),
      snapshot.risk.tradesToday,
    ].join(":");
    const state = this.symbols.get(symbol);
    const now = Date.now();
    const due = !state?.lastPersistAt || now - state.lastPersistAt >= SNAPSHOT_HEARTBEAT_MS;
    if (state && signature === state.lastSnapshotSignature && !due) return;
    if (state) {
      state.lastSnapshotSignature = signature;
      state.lastPersistAt = now;
    }
    const payload: PersistedEngine = { snapshot };
    await this.storage.put({ [snapshotKey(symbol)]: payload });
  }

  engineFor(symbol: string): StrategyEngine | undefined {
    return this.symbols.get(symbol)?.engine;
  }
}
