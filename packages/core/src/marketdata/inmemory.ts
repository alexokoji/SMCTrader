import type { Candle, Timeframe } from "../types/candles.js";
import type { MarketDataProvider } from "./providers.js";

/**
 * In-memory market data provider backed by preloaded candle arrays.
 * Used for tests and the data replay / debug mode.
 */
export class InMemoryMarketData implements MarketDataProvider {
  readonly name = "memory";
  private store: Record<string, Candle[]> = {};

  constructor(seed?: Record<string, Candle[]>) {
    if (seed) this.store = seed;
  }

  load(timeframe: Timeframe, candles: Candle[]): void {
    const key = this.key(timeframe);
    const existing = this.store[key] ?? [];
    const merged = [...existing, ...candles].sort((a, b) => a.timestamp - b.timestamp);
    const dedup: Candle[] = [];
    for (const c of merged) {
      if (dedup.length && dedup[dedup.length - 1].timestamp === c.timestamp) continue;
      dedup.push(c);
    }
    this.store[key] = dedup;
  }

  private key(timeframe: Timeframe): string {
    return `${timeframe}`;
  }

  async getOHLCV(
    symbol: string,
    timeframe: Timeframe,
    startTime: number,
    endTime: number,
    limit?: number,
  ): Promise<Candle[]> {
    const all = this.store[this.key(timeframe)] ?? [];
    let filtered = all.filter(
      (c) => c.symbol === symbol && c.timestamp >= startTime && c.timestamp <= endTime,
    );
    if (limit !== undefined && filtered.length > limit) {
      filtered = filtered.slice(-limit);
    }
    return filtered;
  }

  async getTicker(symbol: string): Promise<{ price: number }> {
    const ltf = this.store["15M"] ?? Object.values(this.store).flat();
    const candle = ltf.find((c) => c.symbol === symbol);
    if (!candle) throw new Error(`No data for ${symbol}`);
    return { price: candle.close };
  }

  async getMarkets(): Promise<string[]> {
    const symbols = new Set<string>();
    for (const list of Object.values(this.store)) {
      for (const c of list) symbols.add(c.symbol);
    }
    return [...symbols];
  }
}
