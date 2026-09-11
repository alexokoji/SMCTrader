/**
 * DexScreener client — live pair metadata, used as a second source rather
 * than the price history source.
 *
 * The free API returns a current snapshot only (no OHLCV), so it cannot feed
 * the trend engine — that is GeckoTerminal's job (see `geckoterminal.ts`).
 * What DexScreener adds here: it indexes chains GeckoTerminal's free tier
 * covers less completely, and a pair worth trading is one two independent
 * indexers agree exists with a real, matching price — a pool this endpoint
 * has never heard of is a reason for caution, not proof of anything on its
 * own, but it is a second data point that costs nothing to check.
 */

const BASE_URL = "https://api.dexscreener.com";

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd: number;
  liquidityUsd: number;
  fdvUsd: number | null;
  volumeUsd24h: number;
  priceChangePct24h: number;
  pairCreatedAt: number | null;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  pairCreatedAt?: number;
}

function toDexPair(pair: DexScreenerPair): DexPair {
  return {
    chainId: pair.chainId,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    url: pair.url,
    baseToken: pair.baseToken,
    quoteToken: pair.quoteToken,
    priceUsd: Number(pair.priceUsd) || 0,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    fdvUsd: pair.fdv ?? null,
    volumeUsd24h: pair.volume?.h24 ?? 0,
    priceChangePct24h: pair.priceChange?.h24 ?? 0,
    pairCreatedAt: pair.pairCreatedAt ?? null,
  };
}

export class DexScreenerClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  /** Search by token symbol, name or address, across every chain DexScreener indexes. */
  async search(query: string): Promise<DexPair[]> {
    const url = `${BASE_URL}/latest/dex/search?q=${encodeURIComponent(query)}`;
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`DexScreener search returned HTTP ${response.status}`);
    const data = (await response.json()) as { pairs: DexScreenerPair[] | null };
    return (data.pairs ?? []).map(toDexPair);
  }

  /** One pair, when the address is already known (e.g. cross-checking a GeckoTerminal pool). */
  async getPair(chainId: string, pairAddress: string): Promise<DexPair | null> {
    const url = `${BASE_URL}/latest/dex/pairs/${chainId}/${pairAddress}`;
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`DexScreener pair lookup returned HTTP ${response.status}`);
    const data = (await response.json()) as { pairs: DexScreenerPair[] | null };
    const pair = data.pairs?.[0];
    return pair ? toDexPair(pair) : null;
  }
}
