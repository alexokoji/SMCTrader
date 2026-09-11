/**
 * CEX market discovery — the same "scout, don't type in a pair" idea the
 * DeFi side uses (`defi/scout.ts`), applied to centralized exchanges.
 *
 * A watchlist a person edits by hand only ever contains what they already
 * thought to add, and stays static until they come back and change it. This
 * instead pulls every USDT pair's 24h volume and price change in a single
 * request per exchange — Binance and Bybit both expose a bulk endpoint that
 * returns every symbol at once, so ranking the whole market costs one call,
 * not one per candidate — and ranks by liquidity, so what a trader sees is
 * whatever is actually most active right now.
 */
import type { PublicExchange } from "./multi-exchange.js";

export interface CexMarketStat {
  symbol: string;
  priceUsd: number;
  quoteVolume24hUsd: number;
  priceChangePct24h: number;
}

export interface ScreenerFilters {
  /** Below this, a pair is too thin to be a serious spot candidate. */
  minQuoteVolume24hUsd: number;
  /** A pair moving more than this in 24h is trading on momentum a spot
   * screen is not the read for; it is filtered rather than ranked highest. */
  maxPriceChangePct24h: number;
}

export const DEFAULT_SCREENER_FILTERS: ScreenerFilters = {
  minQuoteVolume24hUsd: 20_000_000,
  maxPriceChangePct24h: 40,
};

/** Assets that are themselves a stablecoin or fiat proxy — a pair between
 * two of them (or listed against USDT) has no trend worth trading. */
const NON_TRADEABLE_BASES = new Set([
  "USDT", "USDC", "FDUSD", "TUSD", "DAI", "BUSD", "USDP", "PYUSD", "USDE",
  "EUR", "GBP", "TRY", "BRL", "ARS", "UAH", "ZAR", "RUB",
]);

function baseAssetOf(symbol: string): string {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

export function isTradeableBase(symbol: string): boolean {
  return !NON_TRADEABLE_BASES.has(baseAssetOf(symbol));
}

interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
  priceChangePercent: string;
}

interface BybitTicker24h {
  symbol: string;
  lastPrice: string;
  turnover24h: string;
  price24hPcnt: string;
}

export class CexScreener {
  private readonly exchanges: PublicExchange[];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { exchanges?: PublicExchange[]; fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.exchanges = opts.exchanges?.length ? opts.exchanges : ["binance", "bybit"];
    this.fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 10_000);
  }

  private async fetchStats(): Promise<CexMarketStat[]> {
    const failures: string[] = [];
    for (const exchange of this.exchanges) {
      try {
        return await this.statsFor(exchange);
      } catch (error) {
        failures.push(`${exchange}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Bulk 24h stats unavailable across ${this.exchanges.join(", ")}. ${failures.join("; ")}`);
  }

  private async statsFor(exchange: PublicExchange): Promise<CexMarketStat[]> {
    const url =
      exchange === "binance"
        ? "https://api.binance.com/api/v3/ticker/24hr"
        : exchange === "bybit"
          ? "https://api.bybit.com/v5/market/tickers?category=spot"
          : undefined;
    if (!url) throw new Error(`${exchange} has no bulk 24h stats source configured.`);

    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as unknown;

    const rows: unknown[] =
      exchange === "binance"
        ? (data as BinanceTicker24h[])
        : (data as { result?: { list?: BybitTicker24h[] } }).result?.list ?? [];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("returned no tickers");

    const stats: CexMarketStat[] = [];
    for (const row of rows) {
      if (exchange === "binance") {
        const r = row as BinanceTicker24h;
        if (!r.symbol?.endsWith("USDT")) continue;
        const priceUsd = Number(r.lastPrice);
        const quoteVolume24hUsd = Number(r.quoteVolume);
        const priceChangePct24h = Number(r.priceChangePercent);
        if (![priceUsd, quoteVolume24hUsd, priceChangePct24h].every(Number.isFinite)) continue;
        stats.push({ symbol: r.symbol, priceUsd, quoteVolume24hUsd, priceChangePct24h });
      } else {
        const r = row as BybitTicker24h;
        if (!r.symbol?.endsWith("USDT")) continue;
        const priceUsd = Number(r.lastPrice);
        const quoteVolume24hUsd = Number(r.turnover24h);
        const priceChangePct24h = Number(r.price24hPcnt) * 100;
        if (![priceUsd, quoteVolume24hUsd, priceChangePct24h].every(Number.isFinite)) continue;
        stats.push({ symbol: r.symbol, priceUsd, quoteVolume24hUsd, priceChangePct24h });
      }
    }
    if (!stats.length) throw new Error("no USDT pairs parsed from the response");
    return stats;
  }

  /** Every USDT pair currently active, ranked by 24h quote volume — the
   * closest single number to "what is actually tradeable right now." */
  async topMarkets(
    opts: { limit?: number; filters?: ScreenerFilters } = {},
  ): Promise<CexMarketStat[]> {
    const filters = opts.filters ?? DEFAULT_SCREENER_FILTERS;
    const limit = opts.limit ?? 20;
    const stats = await this.fetchStats();
    return stats
      .filter(
        (s) =>
          isTradeableBase(s.symbol) &&
          s.quoteVolume24hUsd >= filters.minQuoteVolume24hUsd &&
          Math.abs(s.priceChangePct24h) <= filters.maxPriceChangePct24h,
      )
      .sort((a, b) => b.quoteVolume24hUsd - a.quoteVolume24hUsd)
      .slice(0, limit);
  }
}
