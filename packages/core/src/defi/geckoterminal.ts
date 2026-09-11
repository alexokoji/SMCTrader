/**
 * GeckoTerminal client — on-chain pool data and OHLCV.
 *
 * DexScreener's free API is a live snapshot only: current price, liquidity,
 * volume and rolling price-change percentages, with no historical candles.
 * That is enough to list and rank pools, but not enough to run a trend read
 * against, which needs a price history. GeckoTerminal's public API (also
 * keyless, same CoinGecko family) exposes indexed OHLCV per pool going back
 * months, so it is the source used for analysis; DexScreener metadata is
 * used separately, for cross-checking a pair before it is trusted (see
 * `dexscreener.ts`).
 *
 * Response shapes below were confirmed against the live API rather than
 * assumed from documentation, since a wrong field name here fails silently
 * (returns `undefined`, not an error) in a codebase that otherwise treats a
 * silent wrong number as worse than a loud failure.
 */
import type { Candle, Timeframe } from "../types/candles.js";

const BASE_URL = "https://api.geckoterminal.com/api/v2";
const ACCEPT_HEADER = "application/json;version=20230302";

export interface PoolInfo {
  network: string;
  poolAddress: string;
  dex: string;
  name: string;
  baseToken: { address: string; symbol: string; name: string; decimals: number };
  quoteToken: { address: string; symbol: string; name: string; decimals: number };
  priceUsd: number;
  liquidityUsd: number;
  fdvUsd: number | null;
  volumeUsd24h: number;
  priceChangePct: { m5: number; h1: number; h6: number; h24: number };
  createdAt: string | null;
}

/** GeckoTerminal timeframe + aggregate that best approximates a requested candle size. */
const TIMEFRAME_TO_GT: Record<Timeframe, { timeframe: "minute" | "hour" | "day"; aggregate: number }> = {
  "5M": { timeframe: "minute", aggregate: 5 },
  "15M": { timeframe: "minute", aggregate: 15 },
  "30M": { timeframe: "minute", aggregate: 30 },
  "1H": { timeframe: "hour", aggregate: 1 },
  "2H": { timeframe: "hour", aggregate: 2 },
  "4H": { timeframe: "hour", aggregate: 4 },
  "1D": { timeframe: "day", aggregate: 1 },
};

interface JsonApiToken {
  id: string;
  type: "token";
  attributes: { address: string; symbol: string; name: string; decimals: number };
}

interface JsonApiPool {
  id: string;
  type: "pool";
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    volume_usd: { h24?: string };
    reserve_in_usd: string;
    price_change_percentage: { m5?: string; h1?: string; h6?: string; h24?: string };
    pool_created_at: string | null;
  };
  relationships: {
    base_token: { data: { id: string; type: "token" } };
    quote_token: { data: { id: string; type: "token" } };
    dex: { data: { id: string; type: "dex" } };
  };
}

function toPoolInfo(network: string, pool: JsonApiPool, included: (JsonApiToken | { id: string; type: string; attributes?: Record<string, unknown> })[]): PoolInfo | null {
  const byId = new Map(included.map((i) => [i.id, i]));
  const base = byId.get(pool.relationships.base_token.data.id) as JsonApiToken | undefined;
  const quote = byId.get(pool.relationships.quote_token.data.id) as JsonApiToken | undefined;
  if (!base || !quote) return null;
  const a = pool.attributes;
  const pct = a.price_change_percentage ?? {};
  return {
    network,
    poolAddress: a.address,
    dex: pool.relationships.dex.data.id,
    name: a.name,
    baseToken: { address: base.attributes.address, symbol: base.attributes.symbol, name: base.attributes.name, decimals: base.attributes.decimals },
    quoteToken: { address: quote.attributes.address, symbol: quote.attributes.symbol, name: quote.attributes.name, decimals: quote.attributes.decimals },
    priceUsd: Number(a.base_token_price_usd) || 0,
    liquidityUsd: Number(a.reserve_in_usd) || 0,
    fdvUsd: a.fdv_usd ? Number(a.fdv_usd) : null,
    volumeUsd24h: Number(a.volume_usd?.h24) || 0,
    priceChangePct: {
      m5: Number(pct.m5) || 0,
      h1: Number(pct.h1) || 0,
      h6: Number(pct.h6) || 0,
      h24: Number(pct.h24) || 0,
    },
    createdAt: a.pool_created_at,
  };
}

export class GeckoTerminalClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    // Bound as a plain closure so a caller invoking `this.fetchFn(...)` never
    // makes `this` the receiver — the exact bug that broke every candle fetch
    // in the Workers runtime once before (see multi-exchange.ts).
    this.fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  private async getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    const response = await this.fetchFn(url.toString(), {
      headers: { Accept: ACCEPT_HEADER },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`GeckoTerminal ${path} returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  /** Search pools by token symbol, name or address, optionally scoped to a network. */
  async searchPools(query: string, network?: string): Promise<PoolInfo[]> {
    const data = await this.getJson<{ data: JsonApiPool[]; included?: JsonApiToken[] }>("/search/pools", {
      query,
      ...(network ? { network } : {}),
      include: "base_token,quote_token,dex",
    });
    return data.data
      .map((pool) => toPoolInfo(network ?? pool.id.split("_")[0] ?? "", pool, data.included ?? []))
      .filter((p): p is PoolInfo => p !== null);
  }

  /** The most actively traded pools on a network right now. */
  async trendingPools(network: string): Promise<PoolInfo[]> {
    const data = await this.getJson<{ data: JsonApiPool[]; included?: JsonApiToken[] }>(
      `/networks/${network}/trending_pools`,
      { include: "base_token,quote_token,dex" },
    );
    return data.data
      .map((pool) => toPoolInfo(network, pool, data.included ?? []))
      .filter((p): p is PoolInfo => p !== null);
  }

  /** One pool's current attributes, for a page that already knows the address. */
  async getPool(network: string, poolAddress: string): Promise<PoolInfo | null> {
    const data = await this.getJson<{ data: JsonApiPool; included?: JsonApiToken[] }>(
      `/networks/${network}/pools/${poolAddress}`,
      { include: "base_token,quote_token,dex" },
    );
    return toPoolInfo(network, data.data, data.included ?? []);
  }

  /**
   * Historical candles for a pool, priced in USD and quoted against the base
   * token — the same shape every other part of this codebase expects, so the
   * existing structure/order-block/liquidity engines can run on it unchanged.
   */
  async getOHLCV(
    network: string,
    poolAddress: string,
    timeframe: Timeframe,
    limit = 200,
  ): Promise<Candle[]> {
    const { timeframe: gtTimeframe, aggregate } = TIMEFRAME_TO_GT[timeframe];
    const data = await this.getJson<{ data: { attributes: { ohlcv_list: number[][] } } }>(
      `/networks/${network}/pools/${poolAddress}/ohlcv/${gtTimeframe}`,
      { aggregate: String(aggregate), limit: String(Math.min(limit, 1000)), currency: "usd" },
    );
    return data.data.attributes.ohlcv_list
      .map(([ts, open, high, low, close, volume]): Candle | null => {
        if (ts === undefined || open === undefined || close === undefined) return null;
        return {
          symbol: poolAddress,
          exchange: `geckoterminal:${network}`,
          timeframe,
          timestamp: ts * 1000, // the API reports seconds; the rest of the app uses ms
          open,
          high: high ?? open,
          low: low ?? open,
          close,
          volume: volume ?? 0,
        };
      })
      .filter((c): c is Candle => c !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}
