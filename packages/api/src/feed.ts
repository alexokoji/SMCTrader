import { timeframeDuration, type Candle, type MarketDataProvider, type StrategyEngine, type Timeframe } from "@smc/core";

export interface PollingFeedServiceOptions {
  engine: StrategyEngine;
  marketData: MarketDataProvider;
  symbol: string;
  timeframes: Timeframe[];
  now?: () => number;
  intervalMs?: number;
  historyLimit?: number;
  /** Optional per-error hook (retries only, not fatal). */
  onError?: (err: unknown) => void;
  /** Hook fired after every successful poll (used to push real-time state). */
  onPollComplete?: () => void;
  /** Number of consecutive poll failures before the feed is considered down. */
  safeModeThreshold?: number;
  /** Triggered once when the failure threshold is reached. Wire to engine.enterSafeMode(). */
  onSafeMode?: (reason: string) => void;
}

export interface FeedStats {
  running: boolean;
  candlesFed: number;
  cyclesProcessed: number;
  lastPollAt: number | null;
  lastPollCandles: number;
  lastError: string | null;
  consecutiveErrors: number;
  safeModeTriggered: boolean;
  perTimeframe: Record<string, number>;
}

/**
 * Polls a market data provider for closed candles across the strategy's
 * timeframes and feeds them into the strategy engine. Only candles whose
 * close time has passed are fed, so the engine never sees an in-progress bar.
 * A one-time backfill on start() populates the engine with recent history.
 */
export class PollingFeedService {
  private readonly engine: StrategyEngine;
  private readonly marketData: MarketDataProvider;
  private readonly symbol: string;
  private readonly timeframes: Timeframe[];
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly historyLimit: number;
  private readonly safeModeThreshold: number;
  private readonly onError?: (err: unknown) => void;
  private readonly onPollComplete?: () => void;
  private readonly onSafeMode?: (reason: string) => void;

  private lastSeen: Map<Timeframe, number> = new Map();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private candlesFed = 0;
  private cyclesProcessed = 0;
  private lastPollAt: number | null = null;
  private lastPollCandles = 0;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private safeModeTriggered = false;

  constructor(opts: PollingFeedServiceOptions) {
    this.engine = opts.engine;
    this.marketData = opts.marketData;
    this.symbol = opts.symbol;
    this.timeframes = [...opts.timeframes];
    this.now = opts.now ?? (() => Date.now());
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.historyLimit = opts.historyLimit ?? 300;
    this.safeModeThreshold = Math.max(1, opts.safeModeThreshold ?? 3);
    this.onError = opts.onError;
    this.onPollComplete = opts.onPollComplete;
    this.onSafeMode = opts.onSafeMode;
  }

  getStats(): FeedStats {
    const perTimeframe: Record<string, number> = {};
    for (const tf of this.timeframes) perTimeframe[tf] = this.lastSeen.get(tf) ?? 0;
    return {
      running: this.running,
      candlesFed: this.candlesFed,
      cyclesProcessed: this.cyclesProcessed,
      lastPollAt: this.lastPollAt,
      lastPollCandles: this.lastPollCandles,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      safeModeTriggered: this.safeModeTriggered,
      perTimeframe,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.backfill();
    } catch {
      // error already recorded by backfill()
    }
    this.timer = setInterval(() => void this.poll().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Load recent closed history for every timeframe so the engine has context. */
  async backfill(): Promise<void> {
    const now = this.now();
    for (const tf of this.timeframes) {
      const dur = timeframeDuration(tf);
      const start = now - this.historyLimit * dur;
      try {
        const candles = await this.marketData.getOHLCV(this.symbol, tf, start, now, this.historyLimit);
        const closed = candles.filter((c) => c.timestamp + dur <= now);
        await this.feedMany(closed);
      } catch (err) {
        this.recordError(err);
        throw err;
      }
    }
  }

  async poll(): Promise<void> {
    const now = this.now();
    const batch: Candle[] = [];
    try {
      for (const tf of this.timeframes) {
        const dur = timeframeDuration(tf);
        const since = this.lastSeen.get(tf) ?? 0;
        const candles = await this.marketData.getOHLCV(this.symbol, tf, since, now, this.historyLimit);
        for (const c of candles) {
          if (c.timestamp <= since) continue;
          if (c.timestamp + dur > now) continue;
          batch.push(c);
        }
      }
      batch.sort((a, b) => a.timestamp - b.timestamp);
      await this.feedMany(batch);
      this.lastPollAt = now;
      this.lastPollCandles = batch.length;
      this.recover();
      this.onPollComplete?.();
    } catch (err) {
      this.recordError(err);
      throw err;
    }
  }

  private async feedMany(candles: Candle[]): Promise<void> {
    for (const c of candles) {
      const cycle = this.engine.onCandleClosed(c);
      if (cycle) this.cyclesProcessed += 1;
      this.candlesFed += 1;
      const cur = this.lastSeen.get(c.timeframe) ?? 0;
      if (c.timestamp > cur) this.lastSeen.set(c.timeframe, c.timestamp);
    }
    await this.engine.flush();
  }

  private recordError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.onError?.(err);
    this.consecutiveErrors += 1;
    // Fail-safe (§68): a persistent feed outage must halt new trading. Once the
    // threshold is reached, safe mode is triggered exactly once; recovery only
    // resets the streak, it never re-enables trading without user intervention.
    if (!this.safeModeTriggered && this.consecutiveErrors >= this.safeModeThreshold) {
      this.safeModeTriggered = true;
      this.onSafeMode?.(
        `Market data feed failed ${this.consecutiveErrors} consecutive polls (${this.lastError}). ` +
          "System entered SAFE MODE - no new trades until intervention.",
      );
    }
  }

  /** A successful poll clears the failure streak (but not safe mode). */
  private recover(): void {
    this.consecutiveErrors = 0;
    this.safeModeTriggered = false;
    this.lastError = null;
  }
}
