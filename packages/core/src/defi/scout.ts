/**
 * Discovery — finds what to watch instead of being told.
 *
 * DeFi has no fixed list of tradeable pairs the way a CEX does: any wallet
 * can deploy a pool for any token in seconds. A watchlist a person edits by
 * hand is the wrong shape for that — it can only ever contain what someone
 * already thought to type in. This scouts every chain in the registry, from
 * two independent sources, for pools that are actually trading, filters out
 * the ones a real trader would never touch, and ranks what is left. Nothing
 * here is a signal to buy; it only narrows "every pool that exists" down to
 * "worth running the analysis engine on this tick."
 *
 * Two sources, not one, and both run on every call rather than one being a
 * fallback for the other:
 *
 * - GeckoTerminal's trending-pools endpoint is an organic, activity-ranked
 *   view per chain. It is also the only source with real OHLCV history, so
 *   whatever it finds is what the analysis engine ultimately reads candles
 *   from.
 * - DexScreener has no organic "trending" endpoint on its free tier — only a
 *   paid-boost list and a self-submitted profile list, neither ranked by
 *   trading activity. Used carelessly that would be a way to launder paid
 *   promotion into "discovered." So it is used only as a source of
 *   addresses: every one is re-verified through DexScreener's own pair data
 *   and has to clear the exact same liquidity/volume/age bar as a
 *   GeckoTerminal candidate. Nothing about being boosted or listed earns a
 *   pool special treatment here.
 *
 * Running both every time — not "DexScreener only if GeckoTerminal is
 * down" — means a chain-wide outage or rate limit on one source degrades
 * discovery instead of stopping it, and the two sources cover different
 * pools in practice, so the merge finds more real candidates than either
 * alone.
 */
import { CHAINS, type ChainId, SUPPORTED_CHAINS } from "./chains.js";
import { DexScreenerClient, type DexPair } from "./dexscreener.js";
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
   * exactly the pattern of a pump designed to be sold into. Only checked
   * when the source reports an hourly figure (GeckoTerminal does; DexScreener
   * does not, so a DexScreener-sourced candidate is not filtered on this). */
  maxPriceChangePct1h: number;
}

export const DEFAULT_SCOUT_FILTERS: ScoutFilters = {
  minLiquidityUsd: 75_000,
  minVolumeUsd24h: 50_000,
  minAgeMs: 24 * 60 * 60 * 1000,
  maxPriceChangePct1h: 60,
};

/** A stablecoin as the *base* side of a pool has no trend to trade — a live
 * discovery run turned up exactly this (a "USDC" candidate on a USDC/DAI-
 * type pool). Symbol-matched rather than address-matched, since a pool can
 * legitimately quote against one stablecoin while its base happens to be
 * another. */
const STABLECOIN_SYMBOLS = new Set([
  "USDT", "USDC", "USDC.E", "DAI", "FDUSD", "TUSD", "BUSD", "USDP", "PYUSD",
  "USDE", "FRAX", "LUSD", "GUSD", "USDD", "CRVUSD", "SUSD",
]);

function isStablecoinBase(symbol: string): boolean {
  return STABLECOIN_SYMBOLS.has(symbol.toUpperCase());
}

export type ScoutSource = "geckoterminal" | "dexscreener";

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
  /** Which source surfaced this pool — shown in the UI so "found by volume
   * ranking" and "found via a boosted/submitted listing, then verified" read
   * differently, since they carry different priors. */
  source: ScoutSource;
  /** True when this candidate was found because a symbol was mentioned in
   * recent news, not by the ordinary trending/boosted sweep — see
   * `discoverFromSymbols`. Still passed through every safety filter. */
  fromNews?: boolean;
}

/** The fields both sources reduce to before filtering — see the module
 * comment for why DexScreener's shape only ever fills `priceChangePct1h`
 * with null rather than approximating it. */
interface ScoutablePool {
  network: ChainId;
  poolAddress: string;
  dex: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: number;
  liquidityUsd: number;
  volumeUsd24h: number;
  priceChangePct1h: number | null;
  priceChangePct24h: number;
  fdvUsd: number | null;
  createdAtMs: number | null;
  source: ScoutSource;
}

function fromGeckoPool(pool: PoolInfo, network: ChainId): ScoutablePool {
  return {
    network,
    poolAddress: pool.poolAddress,
    dex: pool.dex,
    baseToken: pool.baseToken,
    quoteToken: pool.quoteToken,
    priceUsd: pool.priceUsd,
    liquidityUsd: pool.liquidityUsd,
    volumeUsd24h: pool.volumeUsd24h,
    priceChangePct1h: pool.priceChangePct.h1,
    priceChangePct24h: pool.priceChangePct.h24,
    fdvUsd: pool.fdvUsd,
    createdAtMs: pool.createdAt ? Date.parse(pool.createdAt) : null,
    source: "geckoterminal",
  };
}

function fromDexPair(pair: DexPair, network: ChainId): ScoutablePool {
  return {
    network,
    poolAddress: pair.pairAddress,
    dex: pair.dexId,
    baseToken: pair.baseToken,
    quoteToken: pair.quoteToken,
    priceUsd: pair.priceUsd,
    liquidityUsd: pair.liquidityUsd,
    volumeUsd24h: pair.volumeUsd24h,
    priceChangePct1h: null,
    priceChangePct24h: pair.priceChangePct24h,
    fdvUsd: pair.fdvUsd,
    createdAtMs: pair.pairCreatedAt,
    source: "dexscreener",
  };
}

function passesFilters(pool: ScoutablePool, filters: ScoutFilters, now: number): boolean {
  if (isStablecoinBase(pool.baseToken.symbol)) return false;
  if (pool.liquidityUsd < filters.minLiquidityUsd) return false;
  if (pool.volumeUsd24h < filters.minVolumeUsd24h) return false;
  if (pool.priceChangePct1h !== null && Math.abs(pool.priceChangePct1h) > filters.maxPriceChangePct1h) return false;
  if (pool.createdAtMs !== null && Number.isFinite(pool.createdAtMs)) {
    if (now - pool.createdAtMs < filters.minAgeMs) return false;
  }
  // The quote side must be something with a stable meaning (a stablecoin or
  // the chain's wrapped native token) — a pool quoted in a second unknown
  // token has no reliable USD price path and cannot be priced for P/L.
  const chain = CHAINS[pool.network];
  if (!chain) return false;
  const quote = pool.quoteToken.address.toLowerCase();
  const known = [chain.wrappedNativeAddress.toLowerCase(), chain.stableAddress.toLowerCase()];
  if (!known.includes(quote)) return false;
  return true;
}

function toCandidate(pool: ScoutablePool): ScoutCandidate {
  return {
    symbol: poolSymbol(pool.network, pool.poolAddress),
    network: pool.network,
    poolAddress: pool.poolAddress,
    dex: pool.dex,
    baseSymbol: pool.baseToken.symbol,
    baseTokenAddress: pool.baseToken.address,
    quoteSymbol: pool.quoteToken.symbol,
    priceUsd: pool.priceUsd,
    liquidityUsd: pool.liquidityUsd,
    volumeUsd24h: pool.volumeUsd24h,
    priceChangePct24h: pool.priceChangePct24h,
    fdvUsd: pool.fdvUsd,
    turnoverRatio: pool.liquidityUsd > 0 ? pool.volumeUsd24h / pool.liquidityUsd : 0,
    source: pool.source,
  };
}

export class Scout {
  private readonly client: GeckoTerminalClient;
  private readonly dexscreener: DexScreenerClient;

  constructor(opts: { fetchFn?: typeof fetch; client?: GeckoTerminalClient; dexscreener?: DexScreenerClient } = {}) {
    this.client = opts.client ?? new GeckoTerminalClient({ fetchFn: opts.fetchFn });
    this.dexscreener = opts.dexscreener ?? new DexScreenerClient({ fetchFn: opts.fetchFn });
  }

  private async discoverFromGeckoTerminal(
    chains: ChainId[],
    filters: ScoutFilters,
    now: number,
  ): Promise<{ candidates: ScoutCandidate[]; chainErrors: { chain: ChainId; reason: string }[] }> {
    const candidates: ScoutCandidate[] = [];
    const chainErrors: { chain: ChainId; reason: string }[] = [];
    for (const chain of chains) {
      const network = CHAINS[chain].geckoTerminalNetwork;
      try {
        const pools = await this.client.trendingPools(network);
        for (const pool of pools) {
          const tagged = fromGeckoPool(pool, chain);
          if (passesFilters(tagged, filters, now)) candidates.push(toCandidate(tagged));
        }
      } catch (error) {
        chainErrors.push({ chain, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { candidates, chainErrors };
  }

  /**
   * DexScreener's boosted and self-submitted address lists, filtered to
   * chains this registry supports, then re-verified as real trading pairs
   * through DexScreener's own token-lookup endpoint before anything from
   * here is treated as a candidate. See the module comment for why this is
   * never trusted as a ranking on its own.
   */
  private async discoverFromDexScreener(
    chains: ChainId[],
    filters: ScoutFilters,
    now: number,
  ): Promise<{ candidates: ScoutCandidate[]; error?: string }> {
    let leads: { chainId: string; tokenAddress: string }[];
    try {
      const [boosts, profiles] = await Promise.all([
        this.dexscreener.latestBoosts(),
        this.dexscreener.latestProfiles(),
      ]);
      leads = [...boosts, ...profiles];
    } catch (error) {
      return { candidates: [], error: error instanceof Error ? error.message : String(error) };
    }

    const addressesByChain = new Map<ChainId, Set<string>>();
    for (const lead of leads) {
      const chain = chains.find((c) => CHAINS[c].dexScreenerChainId === lead.chainId);
      if (!chain) continue; // a chain this registry does not support at all
      if (!addressesByChain.has(chain)) addressesByChain.set(chain, new Set());
      addressesByChain.get(chain)!.add(lead.tokenAddress);
    }

    const candidates: ScoutCandidate[] = [];
    for (const [chain, addresses] of addressesByChain) {
      try {
        const pairs = await this.dexscreener.getTokens(CHAINS[chain].dexScreenerChainId, [...addresses]);
        for (const pair of pairs) {
          const tagged = fromDexPair(pair, chain);
          if (passesFilters(tagged, filters, now)) candidates.push(toCandidate(tagged));
        }
      } catch {
        // One chain's verification batch failing costs that chain's leads,
        // not the whole DexScreener pass.
      }
    }
    return { candidates };
  }

  /**
   * Sweep every registered chain from both sources, apply the safety
   * filters, dedupe (the same pool can turn up from both), and rank by
   * turnover. One source or one chain failing must not prevent the rest
   * from being scouted.
   */
  async discover(
    opts: { chains?: ChainId[]; filters?: ScoutFilters; limit?: number; now?: number } = {},
  ): Promise<{
    candidates: ScoutCandidate[];
    chainErrors: { chain: ChainId; reason: string }[];
    /** Failures that are not any one chain's — e.g. DexScreener's address
     * lists themselves being unreachable, as opposed to one chain's
     * verification batch failing. */
    sourceErrors: { source: ScoutSource; reason: string }[];
  }> {
    const chains = opts.chains ?? SUPPORTED_CHAINS;
    const filters = opts.filters ?? DEFAULT_SCOUT_FILTERS;
    const now = opts.now ?? Date.now();
    const limit = opts.limit ?? 20;

    const [gecko, dex] = await Promise.all([
      this.discoverFromGeckoTerminal(chains, filters, now),
      this.discoverFromDexScreener(chains, filters, now),
    ]);

    const sourceErrors: { source: ScoutSource; reason: string }[] = [];
    if (dex.error) sourceErrors.push({ source: "dexscreener", reason: dex.error });

    // The same pool can be found by both sources; GeckoTerminal's entry wins
    // a duplicate since it is also the one with real OHLCV history behind it.
    const bySymbol = new Map<string, ScoutCandidate>();
    for (const candidate of [...dex.candidates, ...gecko.candidates]) {
      bySymbol.set(candidate.symbol, candidate);
    }

    const candidates = [...bySymbol.values()].sort((a, b) => b.turnoverRatio - a.turnoverRatio);
    return { candidates: candidates.slice(0, limit), chainErrors: gecko.chainErrors, sourceErrors };
  }

  /**
   * Resolve specific token symbols — typically ones a recent news headline
   * named — to real, currently-trading pools on a registered chain, applying
   * the exact same safety filters as ordinary discovery. This exists
   * because volume/turnover ranking alone can miss a token that is
   * genuinely newsworthy right now but has not yet built up the liquidity
   * to rank on its own; it is never a way around the filters, only a
   * different way of proposing a lead for them to judge.
   *
   * One symbol failing to search (a rate limit, a typo'd ticker with no
   * real match) must not block the others.
   */
  async discoverFromSymbols(
    symbols: string[],
    opts: { chains?: ChainId[]; filters?: ScoutFilters; now?: number } = {},
  ): Promise<ScoutCandidate[]> {
    const chains = opts.chains ?? SUPPORTED_CHAINS;
    const filters = opts.filters ?? DEFAULT_SCOUT_FILTERS;
    const now = opts.now ?? Date.now();

    const bySymbol = new Map<string, ScoutCandidate>();
    for (const symbol of symbols) {
      try {
        const pools = await this.client.searchPools(symbol);
        for (const pool of pools) {
          const chain = chains.find((c) => CHAINS[c].geckoTerminalNetwork === pool.network);
          if (!chain) continue; // not one of the chains this registry supports
          const tagged = fromGeckoPool(pool, chain);
          if (!passesFilters(tagged, filters, now)) continue;
          const candidate = { ...toCandidate(tagged), fromNews: true };
          if (!bySymbol.has(candidate.symbol)) bySymbol.set(candidate.symbol, candidate);
        }
      } catch {
        // This symbol's search failed; the others still get a chance.
      }
    }
    return [...bySymbol.values()];
  }
}
