/**
 * Spot signals.
 *
 * A separate, non-executing surface: the same deterministic SMC engine every
 * agent runs, pointed at a user-chosen watchlist and never allowed to trade.
 * Nothing here sizes a position, places an order, or touches capital — it
 * produces a read of the market (direction, entry, stop, targets, the expected
 * move to each, and why) and hands the decision to the person looking at it.
 *
 * This exists because an agent commits capital the moment its analysis clears
 * the bar; a trader who wants to place spot orders themselves, by hand, on
 * their own exchange account, needs the analysis without the commitment.
 */
import {
  DEFAULT_STRATEGY_CONFIG,
  classifyRegime,
  type StrategyConfig,
} from "@smc/core";
import { TradingRuntime, type AnalysisTick, type RuntimeStorage } from "./runtime.js";
import { fetchNews, type NewsItem } from "./news.js";

/** A large watchlist is exactly what a rotation budget elsewhere in this app
 * exists to avoid re-introducing: every symbol here is analysed every tick. */
export const MAX_WATCHLIST_SYMBOLS = 40;

export const DEFAULT_WATCHLIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];

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

  constructor(storage: RuntimeStorage, opts: { fetchFn?: typeof fetch } = {}) {
    this.storage = storage;
    this.fetchFn = opts.fetchFn;
    // A namespace of its own: this must never share engine state with an
    // agent, even one watching the same symbol, because an agent's engine
    // carries capital and position state that a read-only view must not see
    // or influence.
    this.runtime = new TradingRuntime(storage, { fetchFn: opts.fetchFn, namespace: "spot" });
  }

  async getWatchlist(): Promise<string[]> {
    return (await this.storage.get<string[]>("spotWatchlist")) ?? DEFAULT_WATCHLIST;
  }

  async setWatchlist(symbols: string[]): Promise<{ symbols: string[]; error?: string }> {
    const cleaned = [...new Set(symbols.map((s) => s.toUpperCase().trim()).filter(Boolean))];
    if (cleaned.length === 0) {
      return { symbols: await this.getWatchlist(), error: "The watchlist needs at least one market." };
    }
    if (cleaned.length > MAX_WATCHLIST_SYMBOLS) {
      return {
        symbols: await this.getWatchlist(),
        error: `A watchlist is limited to ${MAX_WATCHLIST_SYMBOLS} markets.`,
      };
    }
    await this.storage.put({ spotWatchlist: cleaned });
    return { symbols: cleaned };
  }

  async getSignals(): Promise<{ signals: SpotSignal[]; updatedAt: number | null }> {
    return (await this.storage.get<{ signals: SpotSignal[]; updatedAt: number }>("spotSignals")) ?? {
      signals: [],
      updatedAt: null,
    };
  }

  /**
   * Analyse every watched market read-only and persist a compact signal per
   * symbol. `autoTrading: false` is the entire safety property of this class —
   * the engine still evaluates every setup and hard rule, it is simply never
   * asked to act on the result.
   */
  async tickAll(now = Date.now()): Promise<SpotSignal[]> {
    const symbols = await this.getWatchlist();
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

        results.push({
          symbol,
          price: lastCloseOf(tick),
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
