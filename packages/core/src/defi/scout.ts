/**
 * Discovery — finds what to watch instead of being told.
 *
 * DeFi has no fixed list of tradeable pairs the way a CEX does: any wallet
 * can deploy a pool for any token in seconds. A watchlist a person edits by
 * hand is the wrong shape for that — it can only ever contain what someone
 * already thought to type in. This scouts every chain in the registry for
 * pools that are actually trading, filters out the ones a real trader would
 * never touch, and ranks what is left. Nothing here is a signal to buy; it
 * only narrows "every pool that exists" down to "worth running the analysis
 * engine on this tick," which `defi-runtime.ts` then does.
 */
import { CHAINS, type ChainId, SUPPORTED_CHAINS } from "./chains.js";
import { GeckoTerminalClient, type PoolInfo } from "./geckoterminal.js";
import { poolSymbol } from "./market-data-adapter.js";

export interface ScoutFilters {
  /** A pool below this cannot absorb a real position without heavy slippage,
   * and is the single most common trait of a pool built to be exited on. */
  minLiquidityUsd: number;
  /** Volume with no liquidity behind it is wash trading; liquidity with no
   * volume is a dead pool. Both are required, not traded off against each
   * other. */
  minVolumeUsd24h: number;
  /** A pool younger than this has not survived a single full trading day —
   * most rug pulls happen within hours of deployment. */
  minAgeMs: number;
  /** Above this, a token's price is easy to move with a small buy, which is
   * exactly the pattern of a pump designed to be sold into. */
  maxPriceChangePct1h: number;
}

export const DEFAULT_SCOUT_FILTERS: ScoutFilters = {
  minLiquidityUsd: 75_000,
  minVolumeUsd24h: 50_000,
  minAgeMs: 24 * 60 * 60 * 1000,
  maxPriceChangePct1h: 60,
};

export interface ScoutCandidate {
  symbol: string;
  network: ChainId;
  poolAddress: string;
  dex: string;
  baseSymbol: string;
  baseTokenAddress: string;
  quoteSymbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volumeUsd24h: number;
  priceChangePct24h: number;
  fdvUsd: number | null;
  /** Volume-to-liquidity, the read used to rank: a pool trading several times
   * its own depth every day has real interest behind it; one sitting on a
   * large liquidity pool with no volume is not where anything is happening. */
  turnoverRatio: number;
}

function passesFilters(pool: PoolInfo, filters: ScoutFilters, now: number): boolean {
  if (pool.liquidityUsd < filters.minLiquidityUsd) return false;
  if (pool.volumeUsd24h < filters.minVolumeUsd24h) return false;
  if (Math.abs(pool.priceChangePct.h1) > filters.maxPriceChangePct1h) return false;
  if (pool.createdAt) {
    const age = now - Date.parse(pool.createdAt);
    if (Number.isFinite(age) && age < filters.minAgeMs) return false;
  }
  // The quote side must be something with a stable meaning (a stablecoin or
  // the chain's wrapped native token) — a pool quoted in a second unknown
  // token has no reliable USD price path and cannot be priced for P/L.
  const chain = CHAINS[pool.network as ChainId];
  if (!chain) return false;
  const quote = pool.quoteToken.address.toLowerCase();
  const known = [chain.wrappedNativeAddress.toLowerCase(), chain.stableAddress.toLowerCase()];
  if (!known.includes(quote)) return false;
  return true;
}

function toCandidate(pool: PoolInfo): ScoutCandidate {
  return {
    symbol: poolSymbol(pool.network, pool.poolAddress),
    network: pool.network as ChainId,
    poolAddress: pool.poolAddress,
    dex: pool.dex,
    baseSymbol: pool.baseToken.symbol,
    baseTokenAddress: pool.baseToken.address,
    quoteSymbol: pool.quoteToken.symbol,
    priceUsd: pool.priceUsd,
    liquidityUsd: pool.liquidityUsd,
    volumeUsd24h: pool.volumeUsd24h,
    priceChangePct24h: pool.priceChangePct.h24,
    fdvUsd: pool.fdvUsd,
    turnoverRatio: pool.liquidityUsd > 0 ? pool.volumeUsd24h / pool.liquidityUsd : 0,
  };
}

export class Scout {
  private readonly client: GeckoTerminalClient;

  constructor(opts: { fetchFn?: typeof fetch; client?: GeckoTerminalClient } = {}) {
    this.client = opts.client ?? new GeckoTerminalClient({ fetchFn: opts.fetchFn });
  }

  /**
   * Sweep every registered chain's trending pools, apply the safety filters,
   * and rank by turnover. One chain failing (a rate limit, an outage) must
   * not prevent the others from being scouted.
   */
  async discover(
    opts: { chains?: ChainId[]; filters?: ScoutFilters; limit?: number; now?: number } = {},
  ): Promise<{ candidates: ScoutCandidate[]; chainErrors: { chain: ChainId; reason: string }[] }> {
    const chains = opts.chains ?? SUPPORTED_CHAINS;
    const filters = opts.filters ?? DEFAULT_SCOUT_FILTERS;
    const now = opts.now ?? Date.now();
    const limit = opts.limit ?? 20;

    const candidates: ScoutCandidate[] = [];
    const chainErrors: { chain: ChainId; reason: string }[] = [];

    for (const chain of chains) {
      const network = CHAINS[chain].geckoTerminalNetwork;
      try {
        const pools = await this.client.trendingPools(network);
        for (const pool of pools) {
          // The registry's chain id (used everywhere else in this codebase)
          // is not always GeckoTerminal's network string, so the pool is
          // re-tagged with the registry id rather than the API's own name.
          const tagged: PoolInfo = { ...pool, network: chain };
          if (passesFilters(tagged, filters, now)) candidates.push(toCandidate(tagged));
        }
      } catch (error) {
        chainErrors.push({ chain, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    candidates.sort((a, b) => b.turnoverRatio - a.turnoverRatio);
    return { candidates: candidates.slice(0, limit), chainErrors };
  }
}
