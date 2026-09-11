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
    const top = await this.screener.topMarkets({ limit: DISCOVERY_COUNT });
    await this.storage.put({ spotCandidates: { markets: top, updatedAt: now } });
    return top;
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
    if (!cachedCandidates.updatedAt || now - cachedCandidates.updatedAt > 15 * 60_000) {
      markets = await this.discover(now).catch((error) => {
        console.warn(JSON.stringify({
          event: "spot_discovery_failed",
          reason: error instanceof Error ? error.message : String(error),
          timestamp: now,
        }));
        return markets;
      });
    }

    const byStat = new Map(markets.map((m) => [m.symbol, m]));
    const discoveredSymbols = markets.map((m) => m.symbol);
    const symbols = [...new Set([...discoveredSymbols, ...pinned])].slice(0, MAX_ANALYSED_MARKETS);
    if (symbols.length === 0) return [];

    const previous = (await this.getSignals()).signals;
    const byPrevious = new Map(previous.map((s) => [s.symbol, s]));

    const news = await fetchNews(symbols, { fetchFn: this.fetchFn }).catch(
      () => ({ items: [] as NewsItem[], unavailable: true, fetchedAt: now, sources: [] }),
    );

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
