import type { StrategyEngine } from "@smc/core";

export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface DailyRolloverSchedulerOptions {
  engine: StrategyEngine;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Detects UTC day boundaries and rolls the strategy engine over to a new
 * trading day (resetting daily loss / trade limits). Uses an injectable clock
 * so tests can simulate midnight without waiting.
 */
export class DailyRolloverScheduler {
  private readonly engine: StrategyEngine;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private currentDayKey: string;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(opts: DailyRolloverSchedulerOptions) {
    this.engine = opts.engine;
    this.now = opts.now ?? (() => Date.now());
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.currentDayKey = utcDayKey(this.now());
  }

  get dayKey(): string {
    return this.currentDayKey;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  tick(): void {
    const now = this.now();
    const key = utcDayKey(now);
    if (key !== this.currentDayKey) {
      this.currentDayKey = key;
      this.engine.rolloverDay(now);
    }
  }
}
