/**
 * Spot signals.
 *
 * A separate, non-executing surface: the same deterministic SMC engine every
 * agent runs, never allowed to trade. Nothing here sizes a position, places
 * an order, or touches capital — it produces a read of the market (direction,
 * entry, stop, targets, the expected move to each, and why) and hands the
 * decision to the person looking at it.
 *
 * What markets it analyses is discovered, not typed in: every tick, the top
 * USDT pairs by 24h volume are pulled from a single bulk exchange call (see
 * `@smc/core`'s `CexScreener`) and analysed automatically — nothing has to be
 * added by hand for the page to show anything. A trader can still pin a
 * market they want kept in view regardless of its ranking; a pin is additive
 * to discovery, never a requirement for it.
 *
 * A market can also arrive via the news: a cashtag ($TICKER) in a recent
 * headline is checked against the same bulk exchange stats, with a much
 * lower volume floor than the ranked list — a genuinely newsworthy pair is
 * not always one of the most liquid ones yet. It still has to be a real,
 * tradeable, non-stablecoin pair that has not moved too far in 24h; being in
 * the news earns a lower bar, not an exemption from having one.
 *
 * This exists because an agent commits capital the moment its analysis clears
 * the bar; a trader who wants to place spot orders themselves, by hand, on
 * their own exchange account, needs the analysis without the commitment.
 */
import {
  CexScreener,
  DEFAULT_STRATEGY_CONFIG,
  classifyRegime,
  type CexMarketStat,
  type StrategyConfig,
} from "@smc/core";
import { TradingRuntime, type AnalysisTick, type RuntimeStorage } from "./runtime.js";
import { fetchNews, type NewsItem } from "./news.js";

/** Bounds total cost per tick: discovered markets plus pins, deduplicated. */
export const MAX_ANALYSED_MARKETS = 15;
export const MAX_PINNED_MARKETS = 10;
const DISCOVERY_COUNT = 10;

export interface SpotSetupView {
  direction: string;
  entryModel: string;
  timeframe: string;
  /** Suggested entry price. On spot this is a level to place a limit order at,
   * or the level price should be near before a market buy — never an
   * instruction, only what the engine's setup is built around. */
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
  pinned: boolean;
  /** Where this market came from this tick: ranked by the screener, kept in
   * view only because it was pinned, or both. */
  discovered: boolean;
  /** True when this market would not have ranked on volume alone and was
   * added because a recent headline named it. */
  newsSource: boolean;
  volumeUsd24h: number | null;
  priceChangePct24h: number | null;
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
  /** Other valid setups on the same market, most recent first, for context. */
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
  private readonly screener: CexScreener;

  constructor(storage: RuntimeStorage, opts: { fetchFn?: typeof fetch } = {}) {
    this.storage = storage;
    this.fetchFn = opts.fetchFn;
    this.screener = new CexScreener({ fetchFn: opts.fetchFn });
    // A namespace of its own: this must never share engine state with an
    // agent, even one watching the same symbol, because an agent's engine
    // carries capital and position state that a read-only view must not see
    // or influence.
    this.runtime = new TradingRuntime(storage, { fetchFn: opts.fetchFn, namespace: "spot" });
  }

  // ---- discovery -----------------------------------------------------

  async discover(now = Date.now()): Promise<CexMarketStat[]> {
    const { top } = await this.discoverWithStats(now);
    return top;
  }

  /**
   * Fetches the bulk exchange stats exactly once and returns both the ranked
   * top markets and the full unfiltered set — so a caller that also needs to
   * verify a couple of news-mentioned symbols this same tick (see `tickAll`)
   * does not pay for a second three-exchange round trip to get it. Calling
   * `allStats()` again after this already burned that budget once is what
   * pushed a production tick over Cloudflare's per-invocation subrequest
   * ceiling — confirmed in a tail immediately after this was first shipped
   * without the reuse.
   */
  private async discoverWithStats(now: number): Promise<{ top: CexMarketStat[]; all: CexMarketStat[] }> {
    const all = await this.screener.allStats();
    const top = await this.screener.topMarkets({ stats: all, limit: DISCOVERY_COUNT });
    await this.storage.put({ spotCandidates: { markets: top, updatedAt: now } });
    return { top, all };
  }

  async getCandidates(): Promise<{ markets: CexMarketStat[]; updatedAt: number | null }> {
    return (await this.storage.get<{ markets: CexMarketStat[]; updatedAt: number }>("spotCandidates")) ?? {
      markets: [],
      updatedAt: null,
    };
  }

  // ---- pins ------------------------------------------------------------

  async getPinned(): Promise<string[]> {
    return (await this.storage.get<string[]>("spotPinned")) ?? [];
  }

  async pin(symbol: string): Promise<{ pinned: string[]; error?: string }> {
    const pinned = await this.getPinned();
    const clean = symbol.toUpperCase().trim();
    if (pinned.includes(clean)) return { pinned };
    if (pinned.length >= MAX_PINNED_MARKETS) {
      return { pinned, error: `You can pin at most ${MAX_PINNED_MARKETS} markets. Unpin one first.` };
    }
    const next = [...pinned, clean];
    await this.storage.put({ spotPinned: next });
    return { pinned: next };
  }

  async unpin(symbol: string): Promise<{ pinned: string[] }> {
    const next = (await this.getPinned()).filter((s) => s !== symbol.toUpperCase().trim());
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
   * Analyse the top discovered markets plus any pinned ones, read-only.
   * `autoTrading: false` is the entire safety property of this class — the
   * engine still evaluates every setup and hard rule, it is simply never
   * asked to act on the result.
   */
  async tickAll(now = Date.now()): Promise<SpotSignal[]> {
    const [pinned, cachedCandidates] = await Promise.all([this.getPinned(), this.getCandidates()]);
    let markets = cachedCandidates.markets;
    // Freshly-fetched full stats, kept only for this tick, so the
    // news-verification step below can reuse them instead of fetching the
    // bulk exchange data a second time — see `discoverWithStats`.
    let freshStats: CexMarketStat[] | undefined;
    if (!cachedCandidates.updatedAt || now - cachedCandidates.updatedAt > 15 * 60_000) {
      await this.discoverWithStats(now)
        .then((result) => {
          markets = result.top;
          freshStats = result.all;
        })
        .catch((error) => {
          console.warn(JSON.stringify({
            event: "spot_discovery_failed",
            reason: error instanceof Error ? error.message : String(error),
            timestamp: now,
          }));
        });
    }

    const byStat = new Map(markets.map((m) => [m.symbol, m]));
    const discoveredSymbols = markets.map((m) => m.symbol);
    let symbols = [...new Set([...discoveredSymbols, ...pinned])];

    const previous = (await this.getSignals()).signals;
    const byPrevious = new Map(previous.map((s) => [s.symbol, s]));

    const news = await fetchNews(symbols, { fetchFn: this.fetchFn }).catch(
      () => ({ items: [] as NewsItem[], unavailable: true, fetchedAt: now, sources: [] }),
    );

    // News-driven extra candidates: a cashtag not already covered, verified
    // as a real tradeable pair before it is trusted. Reuses this tick's
    // discovery stats when they were just fetched; a bulk-stats call is only
    // made from scratch when discovery was a cache hit and a headline still
    // names something new — never both a discovery fetch and a verification
    // fetch in the same tick, which is what pushed a tick over Cloudflare's
    // subrequest ceiling in production before this reuse existed.
    const newsSymbols = new Set<string>();
    const newCashtags = extractCashtags(news.items)
      .map((t) => `${t}USDT`)
      .filter((s) => !symbols.includes(s));
    if (newCashtags.length > 0) {
      try {
        const all = freshStats ?? (await this.screener.allStats());
        for (const stat of this.screener.bySymbol(all, newCashtags).slice(0, 5)) {
          byStat.set(stat.symbol, stat);
          newsSymbols.add(stat.symbol);
          symbols.push(stat.symbol);
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: "spot_news_lookup_failed",
          reason: error instanceof Error ? error.message : String(error),
          timestamp: now,
        }));
      }
    }
    symbols = symbols.slice(0, MAX_ANALYSED_MARKETS);
    if (symbols.length === 0) return [];

    const results: SpotSignal[] = [];
    for (const symbol of symbols) {
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
        const stat = byStat.get(symbol);

        results.push({
          symbol,
          pinned: pinned.includes(symbol),
          discovered: discoveredSymbols.includes(symbol),
          newsSource: newsSymbols.has(symbol),
          volumeUsd24h: stat?.quoteVolume24hUsd ?? null,
          priceChangePct24h: stat?.priceChangePct24h ?? null,
          price: stat?.priceUsd ?? lastCloseOf(tick),
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
        // One failing market keeps its last known signal rather than dropping
        // silently out of the list the trader is watching.
        const prior = byPrevious.get(symbol);
        if (prior) results.push(prior);
        console.warn(JSON.stringify({
          event: "spot_symbol_failed",
          symbol,
          reason: error instanceof Error ? error.message : String(error),
          timestamp: now,
        }));
      }
    }

    await this.storage.put({ spotSignals: { signals: results, updatedAt: now } });
    return results;
  }
}
