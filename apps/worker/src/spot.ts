/**
 * Spot signals.
 *
 * A separate, non-executing surface: the same deterministic SMC engine every
 * agent runs, never allowed to trade. Nothing here sizes a position, places
 * an order, or touches capital — it produces a read of the market (direction,
 * entry, stop, targets, the expected move to each, and why) and hands the
 * decision to the person looking at it.
 *
 * The market this page reads is on-chain (DEX pools), not exchange pairs —
 * the same discovery engine and the same GeckoTerminal-backed analysis as the
 * DeFi spot page (`defi.ts`), reused rather than duplicated. The two pages
 * stay separate on purpose: this one auto-analyses the top discovered pools
 * every tick with no save step, for a trader who wants a live read of
 * whatever the scout is finding right now; DeFi spot requires a pool to be
 * saved before it gets the full engine, and is also where automated
 * execution against a wallet lives. Same underlying market, two different
 * ways of watching it.
 *
 * What gets analysed is discovered, not typed in — every tick, every chain
 * in the registry is scouted for pools trading inside the configured
 * FDV/liquidity/volume range, and the top ones by turnover are analysed
 * automatically. A trader can still pin a pool they want kept in view
 * regardless of its ranking; a pin is additive to discovery, never a
 * requirement for it. Pins are always chosen from the discovered list (see
 * the frontend), never typed in freehand — a DEX pool has no memorable
 * ticker, only a chain and an address.
 *
 * A market can also arrive via the news: a cashtag ($TICKER) in a recent
 * headline is resolved to a real, currently-trading pool through the same
 * scout search used by DeFi spot, and passed through the exact same safety
 * filters as any other candidate.
 *
 * This exists because an agent commits capital the moment its analysis clears
 * the bar; a trader who wants to trade on-chain themselves, by hand, needs
 * the analysis without the commitment.
 */
import {
  DEFAULT_STRATEGY_CONFIG,
  GeckoTerminalMarketDataProvider,
  Scout,
  classifyRegime,
  isSubrequestCeilingError,
  parsePoolSymbol,
  type ChainId,
  type ScoutCandidate,
  type StrategyConfig,
} from "@smc/core";
import { TradingRuntime, type AnalysisTick, type RuntimeStorage } from "./runtime.js";
import { fetchNews, type NewsItem } from "./news.js";

/**
 * Discovery itself has no cap — every pool that clears the scout's filters
 * across every registered chain is returned, since the network cost is the
 * scout sweep itself, already being paid for regardless of how many pools
 * come back.
 *
 * The full SMC engine per pool is a different cost entirely: each one needs
 * its own candle history across three timeframes, which is real network work
 * metered per tick. `MAX_ANALYSED_MARKETS` bounds that expensive half — the
 * same number the exchange-backed version of this page settled on after a
 * production tail showed raising it tripped Cloudflare's per-invocation
 * subrequest ceiling more often. The discovery list above is unaffected
 * either way. Pinned pools are prioritised into this budget ahead of newly
 * discovered ones, since a pin is a promise this pool stays fully analysed
 * regardless of ranking.
 */
export const MAX_ANALYSED_MARKETS = 15;
export const MAX_PINNED_MARKETS = 10;

/** How many pools the scout sweep keeps, pre-ranking — effectively uncapped,
 * matching the CEX-era fix that stopped this page from showing only a
 * handful of majors: the entire complaint that started this rework. */
const DISCOVERY_LIMIT = 500;

export interface SpotSetupView {
  direction: string;
  entryModel: string;
  timeframe: string;
  /** Suggested entry price — a level to place a limit order at, or the level
   * price should be near before a market buy — never an instruction, only
   * what the engine's setup is built around. */
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  /** Percent move from entry to each target, signed with direction: positive
   * is the favourable direction for a BUY, negative levels below entry are
   * expressed as negative percentages so "expected increase" reads plainly. */
  targetMovesPct: number[];
  /** The move to the nearest target — the headline "expected increase". */
  nearestTargetPct: number;
  rr: number[];
  score: number;
  reasons: string[];
  qualityFactors: { name: string; status: string; detail: string }[];
  createdAt: number;
}

export interface SpotSignal {
  symbol: string;
  network: ChainId;
  poolAddress: string;
  dex: string;
  baseSymbol: string;
  quoteSymbol: string;
  pinned: boolean;
  /** Where this pool came from this tick: ranked by the scout, kept in view
   * only because it was pinned, or both. */
  discovered: boolean;
  /** True when this pool would not have ranked on turnover alone and was
   * added because a recent headline named it. */
  newsSource: boolean;
  volumeUsd24h: number | null;
  liquidityUsd: number | null;
  priceChangePct24h: number | null;
  fdvUsd: number | null;
  price: number | null;
  bias: string;
  status: string;
  regime: string | null;
  regimeDetail: string | null;
  warming: boolean;
  noTradeReason: string | null;
  /** The highest-scoring valid setup this tick, if any. Spot trading has no
   * position limit to enforce, so unlike an agent every valid setup is worth
   * showing, not only the ones capital was available for. */
  setup: SpotSetupView | null;
  /** Other valid setups on the same pool, most recent first, for context. */
  alternates: SpotSetupView[];
  news: { title: string; url: string; source: string; sentiment: string; publishedAt: number }[];
  updatedAt: number;
}

function pctMove(direction: string, entry: number, target: number): number {
  if (!(entry > 0)) return 0;
  const raw = ((target - entry) / entry) * 100;
  // A SHORT's favourable move is a falling price; report it as a positive
  // "expected move" in the direction the setup is betting on.
  return direction === "SHORT" ? -raw : raw;
}

function toSetupView(setup: {
  direction: string;
  entryModel: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  rr: number[];
  score: number;
  reasons: string[];
  qualityFactors: { name: string; status: string; detail: string }[];
  createdAt: number;
}): SpotSetupView {
  const targetMovesPct = setup.takeProfits.map((tp) => pctMove(setup.direction, setup.entry, tp));
  return {
    direction: setup.direction,
    entryModel: setup.entryModel,
    timeframe: setup.timeframe,
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfits: setup.takeProfits,
    targetMovesPct,
    nearestTargetPct: targetMovesPct[0] ?? 0,
    rr: setup.rr,
    score: setup.score,
    reasons: setup.reasons,
    qualityFactors: setup.qualityFactors,
    createdAt: setup.createdAt,
  };
}

function lastCloseOf(tick: AnalysisTick): number | null {
  const timeframes = Object.values(tick.analysis.snapshots).reverse();
  for (const snapshot of timeframes) {
    const close = snapshot?.candles.at(-1)?.close;
    if (Number.isFinite(close)) return close as number;
  }
  return null;
}

/** Cashtag mentions ($TICKER) in recent headlines — a common convention for
 * naming a specific token in crypto journalism, and the one pattern that can
 * be pulled from free text without a predefined universe to check against. */
const CASHTAG_RE = /\$([A-Za-z]{2,10})\b/g;

export function extractCashtags(items: { title: string }[]): string[] {
  const found = new Set<string>();
  for (const item of items) {
    for (const match of item.title.matchAll(CASHTAG_RE)) found.add(match[1]!.toUpperCase());
  }
  return [...found];
}

function newsFor(symbol: string, items: NewsItem[]): SpotSignal["news"] {
  return items
    .filter((item) => item.symbols.includes(symbol))
    .slice(0, 3)
    .map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
      sentiment: item.sentiment,
      publishedAt: item.publishedAt,
    }));
}

export class SpotSignalRuntime {
  private readonly runtime: TradingRuntime;
  private readonly storage: RuntimeStorage;
  private readonly fetchFn?: typeof fetch;
  private readonly scout: Scout;

  constructor(storage: RuntimeStorage, opts: { fetchFn?: typeof fetch } = {}) {
    this.storage = storage;
    this.fetchFn = opts.fetchFn;
    this.scout = new Scout({ fetchFn: opts.fetchFn });
    // A namespace of its own: this must never share engine state with an
    // agent, even one watching the same symbol, because an agent's engine
    // carries capital and position state that a read-only view must not see
    // or influence.
    this.runtime = new TradingRuntime(storage, {
      fetchFn: opts.fetchFn,
      namespace: "spot",
      marketData: new GeckoTerminalMarketDataProvider({ fetchFn: opts.fetchFn }),
    });
  }

  // ---- discovery -----------------------------------------------------

  async discover(now = Date.now()): Promise<ScoutCandidate[]> {
    return this.discoverCandidates(now);
  }

  /**
   * A total outage — GeckoTerminal rate-limiting every chain at once, which
   * has happened in production — is not "nothing is trading right now."
   * Writing that through would wipe a working candidate list with an empty
   * one; the previous good candidates are kept instead, and only a warning
   * is logged. Mirrors the same guard in `defi.ts`'s `discover()`.
   */
  private async discoverCandidates(now: number): Promise<ScoutCandidate[]> {
    const result = await this.scout.discover({ now, limit: DISCOVERY_LIMIT });
    if (result.candidates.length === 0 && result.chainErrors.length > 0) {
      const previous = await this.getCandidates();
      console.warn(JSON.stringify({
        event: "spot_discovery_all_chains_failed",
        chainErrors: result.chainErrors,
        sourceErrors: result.sourceErrors,
        keptCandidates: previous.markets.length,
        timestamp: now,
      }));
      return previous.markets;
    }
    await this.storage.put({ spotCandidates: { markets: result.candidates, updatedAt: now } });
    return result.candidates;
  }

  async getCandidates(): Promise<{ markets: ScoutCandidate[]; updatedAt: number | null }> {
    return (await this.storage.get<{ markets: ScoutCandidate[]; updatedAt: number }>("spotCandidates")) ?? {
      markets: [],
      updatedAt: null,
    };
  }

  // ---- pins ------------------------------------------------------------

  async getPinned(): Promise<string[]> {
    return (await this.storage.get<string[]>("spotPinned")) ?? [];
  }

  /** Pins are always chosen from the discovered list (see the frontend), so
   * unlike a typed-in exchange ticker a pool symbol is never normalised —
   * it is a chain id plus a case-sensitive on-chain address. */
  async pin(symbol: string): Promise<{ pinned: string[]; error?: string }> {
    const pinned = await this.getPinned();
    const clean = symbol.trim();
    if (pinned.includes(clean)) return { pinned };
    if (pinned.length >= MAX_PINNED_MARKETS) {
      return { pinned, error: `You can pin at most ${MAX_PINNED_MARKETS} markets. Unpin one first.` };
    }
    const next = [...pinned, clean];
    await this.storage.put({ spotPinned: next });
    return { pinned: next };
  }

  async unpin(symbol: string): Promise<{ pinned: string[] }> {
    const next = (await this.getPinned()).filter((s) => s !== symbol.trim());
    await this.storage.put({ spotPinned: next });
    return { pinned: next };
  }

  async getSignals(): Promise<{ signals: SpotSignal[]; updatedAt: number | null }> {
    return (await this.storage.get<{ signals: SpotSignal[]; updatedAt: number }>("spotSignals")) ?? {
      signals: [],
      updatedAt: null,
    };
  }

  /**
   * Analyse the top discovered pools plus any pinned ones, read-only.
   * `autoTrading: false` is the entire safety property of this class — the
   * engine still evaluates every setup and hard rule, it is simply never
   * asked to act on the result.
   */
  async tickAll(now = Date.now()): Promise<SpotSignal[]> {
    const [pinned, cachedCandidates] = await Promise.all([this.getPinned(), this.getCandidates()]);
    let markets = cachedCandidates.markets;
    if (!cachedCandidates.updatedAt || now - cachedCandidates.updatedAt > 15 * 60_000) {
      await this.discoverCandidates(now)
        .then((result) => {
          markets = result;
        })
        .catch((error) => {
          console.warn(JSON.stringify({
            event: "spot_discovery_failed",
            reason: error instanceof Error ? error.message : String(error),
            timestamp: now,
          }));
        });
    }

    const byCandidate = new Map(markets.map((m) => [m.symbol, m]));
    const discoveredSymbols = markets.map((m) => m.symbol);
    // Pinned pools are guaranteed a full-analysis slot ahead of newly
    // discovered ones — a pin is a promise this pool stays analysed
    // regardless of where it ranks, and `markets` can now be a long list.
    let symbols = [...new Set([...pinned, ...discoveredSymbols])];

    const previous = (await this.getSignals()).signals;
    const byPrevious = new Map(previous.map((s) => [s.symbol, s]));

    const news = await fetchNews(symbols, { fetchFn: this.fetchFn }).catch(
      () => ({ items: [] as NewsItem[], unavailable: true, fetchedAt: now, sources: [] }),
    );

    // News-driven extra candidates: a cashtag not already covered, resolved
    // to a real pool and safety-filtered exactly like any other candidate —
    // see `discoverFromSymbols` in the core Scout.
    const newsSymbols = new Set<string>();
    const newCashtags = extractCashtags(news.items);
    if (newCashtags.length > 0) {
      try {
        for (const candidate of await this.scout.discoverFromSymbols(newCashtags, { now })) {
          if (symbols.includes(candidate.symbol)) continue;
          byCandidate.set(candidate.symbol, candidate);
          newsSymbols.add(candidate.symbol);
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: "spot_news_lookup_failed",
          reason: error instanceof Error ? error.message : String(error),
          timestamp: now,
        }));
      }
    }
    // Pinned first (guaranteed), then news-sourced (the entire point of
    // surfacing one is defeated if a long discovered list pushes it out of
    // the analysed slice), then discovered fills whatever is left.
    symbols = [...new Set([...pinned, ...newsSymbols, ...symbols])].slice(0, MAX_ANALYSED_MARKETS);
    if (symbols.length === 0) {
      // Nothing to show is a real, current answer — a stricter range filter
      // can legitimately clear zero pools some ticks. Write it through
      // rather than silently keeping whatever was analysed last time, or the
      // page is stuck showing pools that no longer qualify, forever.
      await this.storage.put({ spotSignals: { signals: [], updatedAt: now } });
      return [];
    }

    const results: SpotSignal[] = [];
    for (const symbol of symbols) {
      const parsed = parsePoolSymbol(symbol);
      if (!parsed) continue;
      try {
        const strategy: Partial<StrategyConfig> = {
          entryModels: { aggressive: true, confirmation: true, sweep: true, counterTrend: true },
        } as Partial<StrategyConfig>;
        const tick = await this.runtime.tick(symbol, {
          mode: "PAPER",
          risk: {},
          strategy,
          autoTrading: false,
          safetyBlocked: false,
          now,
        });

        const valid = tick.analysis.setups
          .filter((s) => s.status === "VALID")
          .sort((a, b) => b.score - a.score);
        const [top, ...rest] = valid;
        const ltf = tick.analysis.snapshots[DEFAULT_STRATEGY_CONFIG.timeframes.ltf]
          ?? Object.values(tick.analysis.snapshots).find(Boolean);
        const regime = ltf ? classifyRegime(ltf.candles, ltf.structure.trend) : undefined;
        const candidate = byCandidate.get(symbol);

        results.push({
          symbol,
          network: parsed.network as ChainId,
          poolAddress: parsed.poolAddress,
          dex: candidate?.dex ?? "unknown",
          baseSymbol: candidate?.baseSymbol ?? "?",
          quoteSymbol: candidate?.quoteSymbol ?? "?",
          pinned: pinned.includes(symbol),
          discovered: discoveredSymbols.includes(symbol),
          newsSource: newsSymbols.has(symbol),
          volumeUsd24h: candidate?.volumeUsd24h ?? null,
          liquidityUsd: candidate?.liquidityUsd ?? null,
          priceChangePct24h: candidate?.priceChangePct24h ?? null,
          fdvUsd: candidate?.fdvUsd ?? null,
          price: candidate?.priceUsd ?? lastCloseOf(tick),
          bias: tick.analysis.bias,
          status: tick.status,
          regime: regime?.regime ?? null,
          regimeDetail: regime?.detail ?? null,
          warming: tick.warming,
          noTradeReason: tick.analysis.noTradeReason ?? tick.message ?? null,
          setup: top ? toSetupView(top) : null,
          alternates: rest.slice(0, 3).map(toSetupView),
          news: newsFor(symbol, news.items),
          updatedAt: now,
        });
      } catch (error) {
        // One failing pool keeps its last known signal rather than dropping
        // silently out of the list the trader is watching.
        const prior = byPrevious.get(symbol);
        if (prior) results.push(prior);
        console.warn(JSON.stringify({
          event: "spot_symbol_failed",
          symbol,
          reason: error instanceof Error ? error.message : String(error),
          timestamp: now,
        }));
        // Cloudflare's per-invocation subrequest ceiling was hit — every
        // remaining pool in this loop would fail the identical way, each
        // spending what budget is left on a call already known to be
        // doomed. Stop here; the rest keep whatever signal they already had
        // (via byPrevious, above) rather than being wiped by a failure that
        // was never actually about them.
        if (isSubrequestCeilingError(error)) {
          const remaining = symbols.slice(symbols.indexOf(symbol) + 1);
          for (const skipped of remaining) {
            const skippedPrior = byPrevious.get(skipped);
            if (skippedPrior) results.push(skippedPrior);
          }
          console.warn(JSON.stringify({
            event: "spot_tick_stopped_early",
            reason: "subrequest ceiling reached",
            analysed: results.length - remaining.filter((s) => byPrevious.has(s)).length,
            skipped: remaining.length,
            timestamp: now,
          }));
          break;
        }
      }
    }

    await this.storage.put({ spotSignals: { signals: results, updatedAt: now } });
    return results;
  }
}
