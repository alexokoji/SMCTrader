/**
 * CoinGecko market-cap data — the one figure none of the exchange bulk-ticker
 * endpoints carry (they report price, volume and 24h change, never market
 * cap, which needs circulating supply from outside the exchange itself).
 *
 * This exists for one purpose: letting the CEX screener use market cap as a
 * legitimacy floor ("real, established coin") while ranking the coins that
 * clear it by how much they are actually moving — see `screener.ts`.
 * Ranking BY market cap would just reproduce the same handful of majors
 * every time; market cap here is a filter, not a sort key.
 */

export interface CoinGeckoMarket {
  /** Upper-cased base ticker, e.g. "BTC" — matched against an exchange
   * symbol with the quote asset stripped. */
  symbol: string;
  marketCapUsd: number;
  volumeUsd24h: number;
  priceChangePct24h: number;
  priceUsd: number;
  /** CoinGecko's own rank — used to pick a winner when two different coins
   * share a ticker (a real, frequent occurrence outside the top few
   * hundred): the larger, better-known one wins the symbol. */
  marketCapRank: number | null;
}

interface CoinGeckoMarketRow {
  symbol: string;
  market_cap: number | null;
  total_volume: number | null;
  price_change_percentage_24h: number | null;
  current_price: number | null;
  market_cap_rank: number | null;
}

export class CoinGeckoClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async page(pageNumber: number, perPage: number): Promise<CoinGeckoMarketRow[]> {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${pageNumber}`;
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`CoinGecko markets returned HTTP ${response.status}`);
    const data = (await response.json()) as unknown;
    return Array.isArray(data) ? (data as CoinGeckoMarketRow[]) : [];
  }

  /**
   * One retry after a short wait on a 429 specifically — CoinGecko's free
   * tier rate limit is tight enough that a run of several sequential page
   * fetches trips it directly (confirmed live: back-to-back multi-page
   * fetches 429'd on the second attempt within the same minute), and it
   * typically clears within a second or two rather than needing a longer
   * backoff. Any other failure, or a second consecutive 429, is left to the
   * caller.
   */
  private async pageWithRetry(pageNumber: number, perPage: number): Promise<CoinGeckoMarketRow[]> {
    try {
      return await this.page(pageNumber, perPage);
    } catch (error) {
      if (!/HTTP 429/.test(error instanceof Error ? error.message : String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return this.page(pageNumber, perPage);
    }
  }

  /**
   * Coins by market cap, starting from `startPage` and reading up to `pages`
   * pages — or fewer, if `stopBelowMarketCapUsd` is given and a page's
   * lowest cap drops beneath it, since the list is already sorted
   * descending and every later page would only be smaller still. Pages are
   * fetched in sequence, not parallel — CoinGecko's free tier rate-limits
   * per second, and this call sits behind a multi-minute discovery cooldown
   * already, so there is no reason to burst it.
   *
   * `startPage` matters here in a way it would not for a "top N" list: the
   * coins this app now targets sit around rank 1,000-2,500 (confirmed
   * against a live fetch — page 5 is where $10M market cap starts, page 10
   * is roughly where $2M ends), so starting at page 1 would spend most of
   * the pagination budget on majors that are then thrown away.
   */
  async markets(
    opts: { pages?: number; perPage?: number; startPage?: number; stopBelowMarketCapUsd?: number } = {},
  ): Promise<CoinGeckoMarket[]> {
    const pages = opts.pages ?? 2;
    const perPage = Math.min(250, opts.perPage ?? 250);
    const startPage = opts.startPage ?? 1;

    const rows: CoinGeckoMarketRow[] = [];
    for (let i = 0; i < pages; i++) {
      // A short gap between sequential page fetches, not just the 429 retry
      // above — spacing requests out is what actually avoids tripping the
      // rate limit in the first place, rather than recovering after the fact
      // on every single page.
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 250));

      let page: CoinGeckoMarketRow[];
      try {
        page = await this.pageWithRetry(startPage + i, perPage);
      } catch (error) {
        // The first page failing is a real failure — there is nothing to
        // return. A later page failing (even after the retry above) keeps
        // whatever earlier pages already found rather than discarding a
        // partial result that may still cover most of the target range.
        if (i === 0) throw error;
        break;
      }

      rows.push(...page);
      if (page.length < perPage) break; // ran out of ranked coins
      if (opts.stopBelowMarketCapUsd !== undefined) {
        const lowestCap = page[page.length - 1]?.market_cap;
        if (lowestCap !== null && lowestCap !== undefined && lowestCap < opts.stopBelowMarketCapUsd) break;
      }
    }

    // The same ticker can belong to more than one coin (rank determines
    // which one "BTC-the-symbol" means here); keep the highest-ranked
    // (lowest rank number) coin per symbol.
    const bySymbol = new Map<string, CoinGeckoMarket>();
    for (const row of rows) {
      if (!row.symbol || row.market_cap == null || row.total_volume == null || row.current_price == null) continue;
      const symbol = row.symbol.toUpperCase();
      const candidate: CoinGeckoMarket = {
        symbol,
        marketCapUsd: row.market_cap,
        volumeUsd24h: row.total_volume,
        priceChangePct24h: row.price_change_percentage_24h ?? 0,
        priceUsd: row.current_price,
        marketCapRank: row.market_cap_rank,
      };
      const existing = bySymbol.get(symbol);
      if (!existing || (candidate.marketCapRank ?? Infinity) < (existing.marketCapRank ?? Infinity)) {
        bySymbol.set(symbol, candidate);
      }
    }
    return [...bySymbol.values()];
  }
}
