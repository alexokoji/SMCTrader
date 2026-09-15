/**
 * CEX market discovery — the same "scout, don't type in a pair" idea the
 * DeFi side uses (`defi/scout.ts`), applied to centralized exchanges.
 *
 * A watchlist a person edits by hand only ever contains what they already
 * thought to add, and stays static until they come back and change it. This
 * instead pulls every USDT pair's 24h volume and price change in a single
 * request per exchange — Binance, Bybit and OKX each expose a bulk endpoint
 * that returns every symbol at once, so ranking the whole market costs one
 * call per exchange, not one per candidate.
 *
 * All configured exchanges are queried, not "try one, fall back to the next
 * on failure": one exchange being rate-limited or down degrades coverage
 * instead of silently narrowing discovery to whichever exchange happened to
 * answer first, and a symbol only one exchange lists still gets found.
 *
 * Ranking is deliberately not "highest volume first": that ordering puts
 * BTC and ETH at the top of every single scan, because they are always the
 * most-traded pairs in absolute terms — and they are also, day to day, among
 * the least volatile, which makes them a poor match for someone sizing a
 * small position who needs the pair to actually move. Market cap is used as
 * a legitimacy floor instead (a real, established coin, not a thinly-traded
 * micro-cap), and the coins that clear it are ranked by how much they are
 * moving relative to their own size — see `movementScore`.
 */
import type { PublicExchange } from "./multi-exchange.js";
import { CoinGeckoClient, type CoinGeckoMarket } from "./coingecko.js";

export interface CexMarketStat {
  symbol: string;
  priceUsd: number;
  quoteVolume24hUsd: number;
  priceChangePct24h: number;
  /** Exchanges this reading was seen on — one merged figure can come from
   * several sources agreeing, which is itself a mark of a real, liquid pair
   * rather than one thin listing. */
  sources: PublicExchange[];
  /** From CoinGecko; null when the coin was outside the fetched market-cap
   * ranking (e.g. beyond the top 500) — `topMarkets` excludes these, since
   * market cap is exactly the legitimacy signal it uses. */
  marketCapUsd: number | null;
  /** |24h % change| × (24h volume ÷ market cap) — rewards a coin that is
   * both moving and seeing real activity relative to its size; a flat
   * mega-cap and an illiquid pump both score low. Null wherever
   * `marketCapUsd` is null, for the same reason. */
  movementScore: number | null;
}

export interface ScreenerFilters {
  /** Below this, a pair is too thin to be a serious spot candidate. */
  minQuoteVolume24hUsd: number;
  /** A pair moving more than this in 24h is trading on momentum a spot
   * screen is not the read for; it is filtered rather than ranked highest. */
  maxPriceChangePct24h: number;
  /** Below this in 24h movement, a coin is not worth showing regardless of
   * size or liquidity — the entire point of ranking by movement is to leave
   * out the pairs sitting still. */
  minPriceChangePct24h: number;
  /**
   * The legitimacy *range*: a coin outside [minMarketCapUsd,
   * maxMarketCapUsd] is excluded regardless of how much it moved. Below the
   * floor is the classic thinly-capitalized, easily-manipulated token; above
   * the ceiling is the opposite problem this whole ranking exists to route
   * around — a mega-cap that clears every other filter on a big-news day but
   * moves nothing like enough, relative to its size, to be worth a small
   * position. Set for micro-cap trading specifically: this is a narrow band,
   * not a floor with no top.
   */
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
}

export const DEFAULT_SCREENER_FILTERS: ScreenerFilters = {
  // A $2-10M cap coin realistically trading might see $50k-500k of daily
  // volume; requiring millions would exclude the entire target range.
  minQuoteVolume24hUsd: 50_000,
  maxPriceChangePct24h: 60,
  minPriceChangePct24h: 3,
  minMarketCapUsd: 2_000_000,
  maxMarketCapUsd: 10_000_000,
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

function movementScoreOf(stat: { quoteVolume24hUsd: number; priceChangePct24h: number }, marketCapUsd: number | null): number | null {
  if (marketCapUsd === null || marketCapUsd <= 0) return null;
  return Math.abs(stat.priceChangePct24h) * (stat.quoteVolume24hUsd / marketCapUsd);
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
  private readonly coingecko: CoinGeckoClient;

  constructor(opts: { exchanges?: PublicExchange[]; fetchFn?: typeof fetch; timeoutMs?: number; coingecko?: CoinGeckoClient } = {}) {
    this.exchanges = opts.exchanges?.length ? opts.exchanges.filter((e) => BULK_STATS_EXCHANGES.includes(e)) : BULK_STATS_EXCHANGES;
    this.fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 10_000);
    this.coingecko = opts.coingecko ?? new CoinGeckoClient({ fetchFn: opts.fetchFn, timeoutMs: this.timeoutMs });
  }

  /** Queries every configured exchange concurrently and merges the results
   * by symbol; only throws if every one of them failed. Market cap is not
   * joined in here — this is the raw exchange data `topMarkets` and
   * `bySymbol` both build on. */
  private async fetchStats(): Promise<Omit<CexMarketStat, "marketCapUsd" | "movementScore">[]> {
    const results = await Promise.allSettled(this.exchanges.map((ex) => this.statsFor(ex)));

    const byExchange: { exchange: PublicExchange; rows: { symbol: string; priceUsd: number; quoteVolume24hUsd: number; priceChangePct24h: number }[] }[] = [];
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
    const merged = new Map<string, Omit<CexMarketStat, "marketCapUsd" | "movementScore">>();
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

  private async statsFor(exchange: PublicExchange): Promise<{ symbol: string; priceUsd: number; quoteVolume24hUsd: number; priceChangePct24h: number }[]> {
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

    const stats: { symbol: string; priceUsd: number; quoteVolume24hUsd: number; priceChangePct24h: number }[] = [];
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
   * Every USDT pair currently active, joined with CoinGecko market caps and
   * unfiltered/unranked — the raw material `topMarkets` and `bySymbol` both
   * work from. Exposed so a caller that needs both (rank the market, and
   * separately look a few specific symbols up) pays for the bulk fetch once
   * instead of twice. A CoinGecko outage does not fail this — every reading
   * just carries a null market cap, which `topMarkets` then excludes.
   *
   * The CoinGecko pagination is calibrated to `filters.minMarketCapUsd`, not
   * fetched from page 1: this app's targeted range (a live check found $10M
   * market cap starts around CoinGecko rank ~1,150, i.e. page 5 of 250) sits
   * far below the top of the list, so starting at page 1 would spend most of
   * the pagination budget fetching majors this screener no longer wants at
   * all. `stopBelowMarketCapUsd` still bounds the worst case if the market's
   * rank distribution drifts.
   */
  async allStats(filters: ScreenerFilters = DEFAULT_SCREENER_FILTERS): Promise<CexMarketStat[]> {
    const [stats, marketCaps] = await Promise.all([
      this.fetchStats(),
      this.coingecko
        .markets({ startPage: 4, pages: 10, stopBelowMarketCapUsd: filters.minMarketCapUsd })
        .catch((): CoinGeckoMarket[] => []),
    ]);
    const byBase = new Map(marketCaps.map((m) => [m.symbol, m]));
    return stats.map((s) => {
      const cap = byBase.get(baseAssetOf(s.symbol))?.marketCapUsd ?? null;
      return { ...s, marketCapUsd: cap, movementScore: movementScoreOf(s, cap) };
    });
  }

  /**
   * Coins that clear the market-cap legitimacy floor, ranked by how much
   * they are moving relative to their own size — not by raw volume, which
   * only ever surfaces the same handful of megacaps (see the module
   * comment). No result-count cap by default: everything that passes the
   * filters is returned, since filtering out the wrong candidates is what
   * keeps this list meaningful, not truncating a correctly-filtered one.
   */
  async topMarkets(
    opts: { limit?: number; filters?: ScreenerFilters; stats?: CexMarketStat[] } = {},
  ): Promise<CexMarketStat[]> {
    const filters = opts.filters ?? DEFAULT_SCREENER_FILTERS;
    const stats = opts.stats ?? (await this.allStats(filters));
    const ranked = stats
      .filter(
        (s) =>
          isTradeableBase(s.symbol) &&
          s.marketCapUsd !== null &&
          s.marketCapUsd >= filters.minMarketCapUsd &&
          s.marketCapUsd <= filters.maxMarketCapUsd &&
          s.quoteVolume24hUsd >= filters.minQuoteVolume24hUsd &&
          Math.abs(s.priceChangePct24h) >= filters.minPriceChangePct24h &&
          Math.abs(s.priceChangePct24h) <= filters.maxPriceChangePct24h,
      )
      .sort((a, b) => (b.movementScore ?? 0) - (a.movementScore ?? 0));
    return opts.limit !== undefined ? ranked.slice(0, opts.limit) : ranked;
  }

  /**
   * Look up specific symbols (e.g. ones a news headline just named) against
   * already-fetched stats, with a much lower volume floor than `topMarkets`
   * and no minimum-movement requirement — a pair worth surfacing because it
   * is in the news right now is not always one of the most liquid or most
   * volatile pairs on the exchange, but it still has to be a real,
   * tradeable, non-stablecoin USDT pair that has not moved so far in 24h
   * that a spot read on it is unreliable.
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
