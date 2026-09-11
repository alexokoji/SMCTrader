/**
 * Adapts GeckoTerminal to the same `MarketDataProvider` interface the CEX
 * engine reads from.
 *
 * This is the entire reason a DeFi pool gets the real SMC engine — structure,
 * BOS/CHoCH, liquidity sweeps, FVGs, order blocks, entry models, all of it —
 * instead of a smaller bespoke model built just for this: the analysis and
 * strategy engines only ever ask a `MarketDataProvider` for candles, and this
 * class is that provider backed by on-chain pool data instead of an exchange.
 *
 * A DeFi pool has no ticker symbol, so the provider's `symbol` is the pool's
 * identity: `"{network}:{poolAddress}"`. Every caller in this codebase treats
 * a symbol as an opaque string key already (it is used to key storage and
 * in-memory maps, never parsed), so this needs no changes anywhere else.
 */
import type { Candle, Timeframe } from "../types/candles.js";
import type { MarketDataProvider } from "../marketdata/providers.js";
import { GeckoTerminalClient } from "./geckoterminal.js";

export function poolSymbol(network: string, poolAddress: string): string {
  return `${network}:${poolAddress}`;
}

export function parsePoolSymbol(symbol: string): { network: string; poolAddress: string } | null {
  const i = symbol.indexOf(":");
  if (i < 0) return null;
  return { network: symbol.slice(0, i), poolAddress: symbol.slice(i + 1) };
}

export class GeckoTerminalMarketDataProvider implements MarketDataProvider {
  readonly name = "geckoterminal";
  private readonly client: GeckoTerminalClient;

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number; client?: GeckoTerminalClient } = {}) {
    this.client = opts.client ?? new GeckoTerminalClient({ fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs });
  }

  async getOHLCV(
    symbol: string,
    timeframe: Timeframe,
    _startTime: number,
    _endTime: number,
    limit = 200,
  ): Promise<Candle[]> {
    const parsed = parsePoolSymbol(symbol);
    if (!parsed) throw new Error(`Not a pool symbol: "${symbol}" (expected "network:poolAddress")`);
    const candles = await this.client.getOHLCV(parsed.network, parsed.poolAddress, timeframe, limit);
    // The shared Candle shape carries a generic `symbol` field; every other
    // consumer in this codebase keys off the runtime's own symbol, not this
    // one, but it is set to the pool identity rather than left as the raw
    // pool address the client returns, so a log or a snapshot naming it reads
    // the same identity used everywhere else.
    return candles.map((c) => ({ ...c, symbol }));
  }

  async getTicker(symbol: string): Promise<{ price: number }> {
    const parsed = parsePoolSymbol(symbol);
    if (!parsed) throw new Error(`Not a pool symbol: "${symbol}" (expected "network:poolAddress")`);
    const pool = await this.client.getPool(parsed.network, parsed.poolAddress);
    if (!pool) throw new Error(`Pool not found: ${symbol}`);
    return { price: pool.priceUsd };
  }

  /** DeFi has no fixed market list — see `scout.ts` for how pools are found. */
  async getMarkets(): Promise<string[]> {
    return [];
  }
}
