/**
 * CEX market discovery — the same "scout, don't type in a pair" idea the
 * DeFi side uses (`defi/scout.ts`), applied to centralized exchanges.
 *
 * A watchlist a person edits by hand only ever contains what they already
 * thought to add, and stays static until they come back and change it. This
 * instead pulls every USDT pair's 24h volume and price change in a single
 * request per exchange — Binance, Bybit and OKX each expose a bulk endpoint
 * that returns every symbol at once, so ranking the whole market costs one
 * call per exchange, not one per candidate — and ranks by liquidity, so what
 * a trader sees is whatever is actually most active right now.
 *
 * All configured exchanges are queried, not "try one, fall back to the next
 * on failure": one exchange being rate-limited or down degrades coverage
 * instead of silently narrowing discovery to whichever exchange happened to
 * answer first, and a symbol only one exchange lists still gets found.
 */
import type { PublicExchange } from "./multi-exchange.js";

export interface CexMarketStat {
  symbol: string;
  priceUsd: number;
  quoteVolume24hUsd: number;
  priceChangePct24h: number;
  /** Exchanges this reading was seen on — one merged figure can come from
   * several sources agreeing, which is itself a mark of a real, liquid pair
   * rather than one thin listing. */
  sources: PublicExchange[];
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

/** Exchanges with a documented bulk "every symbol's 24h stats in one call"
 * endpoint. Others in `PublicExchange` (bitget, kucoin) do not expose one on
 * their public tier and are left to the per-symbol candle/ticker path used
 * elsewhere in this codebase. */
const BULK_STATS_EXCHANGES: PublicExchange[] = ["binance", "bybit", "okx"];

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

/** OKX reports instruments as "BTC-USDT"; every other exchange and the rest
 * of this codebase uses "BTCUSDT". */
interface OkxTicker24h {
  instId: string;
  last: string;
  volCcy24h: string;
  open24h: string;
}

function okxSymbol(instId: string): string | null {
  return instId.endsWith("-USDT") ? instId.replace("-", "") : null;
}

export class CexScreener {
  private readonly exchanges: PublicExchange[];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { exchanges?: PublicExchange[]; fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.exchanges = opts.exchanges?.length ? opts.exchanges.filter((e) => BULK_STATS_EXCHANGES.includes(e)) : BULK_STATS_EXCHANGES;
    this.fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 10_000);
  }

  /** Queries every configured exchange concurrently and merges the results
   * by symbol; only throws if every one of them failed. */
  private async fetchStats(): Promise<CexMarketStat[]> {
    const results = await Promise.allSettled(this.exchanges.map((ex) => this.statsFor(ex)));

    const byExchange: { exchange: PublicExchange; rows: Omit<CexMarketStat, "sources">[] }[] = [];
    const failures: string[] = [];
    results.forEach((result, i) => {
      const exchange = this.exchanges[i]!;
      if (result.status === "fulfilled") byExchange.push({ exchange, rows: result.value });
      else failures.push(`${exchange}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    });

    if (byExchange.length === 0) {
      throw new Error(`Bulk 24h stats unavailable across ${this.exchanges.join(", ")}. ${failures.join("; ")}`);
    }

    // Merge by symbol: the reading with the highest reported volume wins
    // (exchanges report slightly different figures for the same pair), and
    // every exchange that listed the symbol is recorded.
    const merged = new Map<string, CexMarketStat>();
    for (const { exchange, rows } of byExchange) {
      for (const row of rows) {
        const existing = merged.get(row.symbol);
        if (!existing) {
          merged.set(row.symbol, { ...row, sources: [exchange] });
        } else {
          existing.sources.push(exchange);
          if (row.quoteVolume24hUsd > existing.quoteVolume24hUsd) {
            existing.priceUsd = row.priceUsd;
            existing.quoteVolume24hUsd = row.quoteVolume24hUsd;
            existing.priceChangePct24h = row.priceChangePct24h;
          }
        }
      }
    }
    return [...merged.values()];
  }

  private async statsFor(exchange: PublicExchange): Promise<Omit<CexMarketStat, "sources">[]> {
    const url =
      exchange === "binance"
        ? "https://api.binance.com/api/v3/ticker/24hr"
        : exchange === "bybit"
          ? "https://api.bybit.com/v5/market/tickers?category=spot"
          : exchange === "okx"
            ? "https://www.okx.com/api/v5/market/tickers?instType=SPOT"
            : undefined;
    if (!url) throw new Error(`${exchange} has no bulk 24h stats source configured.`);

    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as unknown;

    const rows: unknown[] =
      exchange === "binance"
        ? (data as BinanceTicker24h[])
        : exchange === "bybit"
          ? (data as { result?: { list?: BybitTicker24h[] } }).result?.list ?? []
          : (data as { data?: OkxTicker24h[] }).data ?? [];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("returned no tickers");

    const stats: Omit<CexMarketStat, "sources">[] = [];
    for (const row of rows) {
      if (exchange === "binance") {
        const r = row as BinanceTicker24h;
        if (!r.symbol?.endsWith("USDT")) continue;
        const priceUsd = Number(r.lastPrice);
        const quoteVolume24hUsd = Number(r.quoteVolume);
        const priceChangePct24h = Number(r.priceChangePercent);
        if (![priceUsd, quoteVolume24hUsd, priceChangePct24h].every(Number.isFinite)) continue;
        stats.push({ symbol: r.symbol, priceUsd, quoteVolume24hUsd, priceChangePct24h });
      } else if (exchange === "bybit") {
        const r = row as BybitTicker24h;
        if (!r.symbol?.endsWith("USDT")) continue;
        const priceUsd = Number(r.lastPrice);
        const quoteVolume24hUsd = Number(r.turnover24h);
        const priceChangePct24h = Number(r.price24hPcnt) * 100;
        if (![priceUsd, quoteVolume24hUsd, priceChangePct24h].every(Number.isFinite)) continue;
        stats.push({ symbol: r.symbol, priceUsd, quoteVolume24hUsd, priceChangePct24h });
      } else {
        const r = row as OkxTicker24h;
        const symbol = r.instId ? okxSymbol(r.instId) : null;
        if (!symbol) continue;
        const priceUsd = Number(r.last);
        const open = Number(r.open24h);
        const quoteVolume24hUsd = Number(r.volCcy24h);
        if (![priceUsd, open, quoteVolume24hUsd].every(Number.isFinite) || open <= 0) continue;
        const priceChangePct24h = ((priceUsd - open) / open) * 100;
        stats.push({ symbol, priceUsd, quoteVolume24hUsd, priceChangePct24h });
      }
    }
    if (!stats.length) throw new Error("no USDT pairs parsed from the response");
    return stats;
  }

  /**
   * Every USDT pair currently active, unfiltered and unranked — the raw
   * material `topMarkets` and `bySymbol` both work from. Exposed so a caller
   * that needs both (rank by volume, and separately look a few specific
   * symbols up) pays for the bulk fetch once instead of twice.
   */
  async allStats(): Promise<CexMarketStat[]> {
    return this.fetchStats();
  }

  /** Every USDT pair currently active, ranked by 24h quote volume — the
   * closest single number to "what is actually tradeable right now." */
  async topMarkets(
    opts: { limit?: number; filters?: ScreenerFilters; stats?: CexMarketStat[] } = {},
  ): Promise<CexMarketStat[]> {
    const filters = opts.filters ?? DEFAULT_SCREENER_FILTERS;
    const limit = opts.limit ?? 20;
    const stats = opts.stats ?? (await this.fetchStats());
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

  /**
   * Look up specific symbols (e.g. ones a news headline just named) against
   * already-fetched stats, with a much lower volume floor than `topMarkets`
   * — a pair worth surfacing because it is in the news right now is not
   * always one of the most liquid pairs on the exchange, but it still has to
   * be a real, tradeable, non-stablecoin USDT pair that has not moved so far
   * in 24h that a spot read on it is unreliable.
   */
  bySymbol(
    stats: CexMarketStat[],
    symbols: string[],
    opts: { minQuoteVolume24hUsd?: number; maxPriceChangePct24h?: number } = {},
  ): CexMarketStat[] {
    const wanted = new Set(symbols.map((s) => s.toUpperCase()));
    const minVolume = opts.minQuoteVolume24hUsd ?? 2_000_000;
    const maxChange = opts.maxPriceChangePct24h ?? DEFAULT_SCREENER_FILTERS.maxPriceChangePct24h;
    return stats.filter(
      (s) =>
        wanted.has(s.symbol) &&
        isTradeableBase(s.symbol) &&
        s.quoteVolume24hUsd >= minVolume &&
        Math.abs(s.priceChangePct24h) <= maxChange,
    );
  }
}
