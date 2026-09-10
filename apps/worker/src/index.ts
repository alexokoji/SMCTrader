import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_RISK_CONFIG,
  MultiExchangeMarketData,
  TIMEFRAME_DURATION_MS,
  computePerformance,
  runBacktest as runHistoricalBacktest,
  validateRiskConfig,
  type ManagedPosition,
  type Setup,
} from "@smc/core";
import {
  STEADY_TICK_MS,
  TradingRuntime,
  WARMING_TICK_MS,
  type AnalysisTick,
  type RuntimeStorage,
} from "./runtime.js";
import { sendIngest } from "./ingest.js";
import { AgentRuntime, defaultAgentConfig } from "./agents.js";
import { SpotSignalRuntime, type SpotSignal } from "./spot.js";
import { cautionSymbols, fetchNews, type NewsResult } from "./news.js";

interface Env {
  TRADING_SESSION: DurableObjectNamespace<TradingSession>;
  ALLOWED_ORIGIN?: string;
  WORKER_AUTH_SECRET?: string;
  /** Origin of the platform API that owns the MongoDB connection. */
  PLATFORM_API_URL?: string;
}

type RuntimeMode = "ANALYSIS_ONLY" | "PAPER" | "LIVE";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
// Risk defaults are owned by the engine so the Worker cannot drift from the
// limits the strategy and tests are written against.
const { correlationGroups: _correlationGroups, ...DEFAULT_RISK } = DEFAULT_RISK_CONFIG;
const STARTING_EQUITY = 10_000;
/**
 * Lower-timeframe candles a single backtest request will replay. Each one runs
 * a full engine cycle, so this bounds the invocation's CPU time.
 */
const MAX_BACKTEST_CANDLES = 4_000;

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers(JSON_HEADERS);
  const origin = request.headers.get("origin");
  if (origin && (!env.ALLOWED_ORIGIN || origin === env.ALLOWED_ORIGIN)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  return headers;
}

function json(request: Request, env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request, env) });
}

async function authenticatedUser(request: Request, env: Env): Promise<string | undefined> {
  let value = request.headers.get("authorization");
  if (!value) {
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((item) => item.trim()) ?? [];
    const protocolToken = protocols.find((item) => item.includes("."));
    if (protocolToken) value = `Bearer ${protocolToken}`;
  }
  if (!env.WORKER_AUTH_SECRET || !value?.startsWith("Bearer ")) return undefined;
  const [payload, signature] = value.slice(7).split(".");
  if (!payload || !signature) return undefined;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WORKER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), new TextEncoder().encode(payload));
  if (!valid) return undefined;
  try { const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string; exp?: number }; return typeof claims.sub === "string" && typeof claims.exp === "number" && claims.exp > Date.now() ? claims.sub : undefined; } catch { return undefined; }
}

function baseState(mode: RuntimeMode, assets: string[]) {
  return {
    symbol: assets[0] ?? "BTCUSDT", exchange: "multi-exchange", marketDataSource: "worker-starter",
    timeframes: { htf: "4h", mtf: "1h", ltf: "15m" }, mode, autoTrading: false,
    safetyBlocked: false, strategyVersion: "cloudflare-paper-v1", dayKey: new Date().toISOString().slice(0, 10),
    feed: { running: true, candlesFed: 0, cyclesProcessed: 0, lastPollAt: null, lastPollCandles: 0, lastError: null, consecutiveErrors: 0, safeModeTriggered: false, perTimeframe: {} },
  };
}

/**
 * Reshape a runtime tick into the API's analysis contract. Per-timeframe
 * snapshots are deliberately omitted: they carry candle buffers and zone
 * geometry, and are served separately by `/api/chart`.
 */
function serializeAnalysis(tick: AnalysisTick): Record<string, unknown> {
  const { analysis } = tick;
  return {
    symbol: analysis.symbol,
    exchange: tick.exchange,
    bias: analysis.bias,
    status: tick.status,
    warming: tick.warming,
    // Prefer the engine's own account of why nothing is tradeable.
    message: tick.message ?? analysis.noTradeReason ?? null,
    noTradeReason: analysis.noTradeReason ?? null,
    topDown: analysis.topDown,
    setups: analysis.setups,
    events: analysis.events.map((event) => ({
      type: event.type,
      description: event.detail,
      timestamp: event.timestamp,
    })),
    updatedAt: analysis.updatedAt,
  };
}

/**
 * Setups kept per market in stored analysis. A stored value has a hard size
 * limit and a setup carries its full rule evaluation, so keeping every one of
 * them for every market overflowed it.
 */
const STORED_SETUPS_PER_MARKET = 8;

/** A stored analysis without the parts that have no bound. */
function compactAnalysis(analysis: Record<string, unknown>): Record<string, unknown> {
  const setups = Array.isArray(analysis.setups) ? analysis.setups : [];
  return {
    ...analysis,
    setups: setups.slice(0, STORED_SETUPS_PER_MARKET).map((setup) => {
      const { components, timeframeAnalysis, ...rest } = setup as Record<string, unknown>;
      return rest;
    }),
    events: Array.isArray(analysis.events) ? analysis.events.slice(-20) : [],
  };
}

function lastCloseOf(tick: AnalysisTick): number | null {
  const timeframes = Object.values(tick.analysis.snapshots);
  for (const snapshot of timeframes.reverse()) {
    const close = snapshot?.candles.at(-1)?.close;
    if (Number.isFinite(close)) return close as number;
  }
  return null;
}

export class TradingSession extends DurableObject<Env> {
  private runtimeInstance?: TradingRuntime;
  /** Guards against rewriting unchanged engine output every tick. */
  private lastEngineSignature = "";
  private lastAnyWarming?: boolean;
  private agentRuntimeInstance?: AgentRuntime;
  private spotRuntimeInstance?: SpotSignalRuntime;

  /** Agents are held on the instance so their engines stay warm between ticks. */
  private agents(): AgentRuntime {
    if (!this.agentRuntimeInstance) {
      this.agentRuntimeInstance = new AgentRuntime({
        get: <T,>(key: string) => this.ctx.storage.get<T>(key),
        put: (entries: Record<string, unknown>) => this.ctx.storage.put(entries),
      });
    }
    return this.agentRuntimeInstance;
  }

  /**
   * Read-only market analysis for the spot watchlist. Held on the instance for
   * the same reason as agents: its engines stay warm between ticks. It never
   * shares state with `agents()` — see the comment on `SpotSignalRuntime`.
   */
  private spot(): SpotSignalRuntime {
    if (!this.spotRuntimeInstance) {
      this.spotRuntimeInstance = new SpotSignalRuntime({
        get: <T,>(key: string) => this.ctx.storage.get<T>(key),
        put: (entries: Record<string, unknown>) => this.ctx.storage.put(entries),
      });
    }
    return this.spotRuntimeInstance;
  }

  async getWatchlist(): Promise<string[]> {
    return this.spot().getWatchlist();
  }

  async setWatchlist(symbols: string[]): Promise<{ symbols: string[]; error?: string }> {
    return this.spot().setWatchlist(symbols);
  }

  async getSpotSignals(): Promise<{ signals: SpotSignal[]; updatedAt: number | null }> {
    return this.spot().getSignals();
  }

  /**
   * Advance the spot watchlist. Failures here are contained exactly like
   * `tickAgents`: a bad market or feed outage must not stop the alarm loop
   * that trading agents also depend on.
   */
  async tickSpot(): Promise<void> {
    try {
      await this.spot().tickAll();
    } catch (error) {
      console.error(JSON.stringify({
        event: "spot_tick_failed",
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      }));
    }
  }

  // ---- agents ------------------------------------------------------------

  async listAgents(): Promise<Record<string, unknown>> {
    const snapshots = await this.agents().snapshots();
    const committed = snapshots
      .filter((s) => s.config.status !== "STOPPED")
      .reduce((sum, s) => sum + s.config.allocatedCapital, 0);
    return {
      agents: snapshots,
      capital: { total: await this.totalCapital(), committed },
    };
  }

  /**
   * Capital an operator may allocate. Paper capital is whatever they nominate;
   * live capital would come from the exchange balance, which is not connected,
   * so it is reported as zero rather than invented.
   */
  async totalCapital(): Promise<number> {
    return (await this.ctx.storage.get<number>("paperCapital")) ?? STARTING_EQUITY;
  }

  async setPaperCapital(amount: number): Promise<{ total: number }> {
    const total = Math.max(0, amount);
    await this.ctx.storage.put({ paperCapital: total });
    return { total };
  }

  async createAgent(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbols = Array.isArray(input.symbols)
      ? (input.symbols as string[]).map((s) => String(s).toUpperCase().replace("/", ""))
      : [];
    const result = await this.agents().create(
      {
        id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: String(input.name ?? "Agent").slice(0, 60),
        mode: input.mode === "LIVE" ? "LIVE" : "PAPER",
        allocatedCapital: Number(input.allocatedCapital),
        symbols,
        entryModels: Array.isArray(input.entryModels) ? (input.entryModels as never) : undefined,
        riskPerTrade: input.riskPerTrade === undefined ? undefined : Number(input.riskPerTrade),
        minRr: input.minRr === undefined ? undefined : Number(input.minRr),
        requiredRegimes: Array.isArray(input.requiredRegimes) ? (input.requiredRegimes as string[]) : undefined,
      },
      await this.totalCapital(),
    );
    if (result.error) return { error: result.error };
    await this.ensureAnalysisAlarm();
    return { agent: result.agent };
  }

  async updateAgent(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.agents().update(id, patch as never, await this.totalCapital());
    return result.error ? { error: result.error } : { agent: result.agent };
  }

  async deleteAgent(id: string): Promise<Record<string, unknown>> {
    return { removed: await this.agents().remove(id) };
  }

  async agentTrades(): Promise<Record<string, unknown>> {
    return { trades: await this.agents().trades() };
  }

  /** Portfolio across every agent: what is committed, held and realised. */
  async portfolio(): Promise<Record<string, unknown>> {
    const snapshots = await this.agents().snapshots();
    const total = await this.totalCapital();
    const committed = snapshots
      .filter((s) => s.config.status !== "STOPPED")
      .reduce((sum, s) => sum + s.config.allocatedCapital, 0);
    const equity = snapshots.reduce((sum, s) => sum + s.performance.equity, 0);
    const realised = snapshots.reduce((sum, s) => sum + s.performance.netPnl, 0);
    const openPositions = snapshots.reduce((sum, s) => sum + s.performance.openPositions, 0);
    const closedTrades = snapshots.reduce((sum, s) => sum + s.performance.closedTrades, 0);
    const wins = snapshots.reduce((sum, s) => sum + s.performance.wins, 0);

    return {
      totalCapital: total,
      committed,
      uncommitted: Math.max(0, total - committed),
      equity: equity + Math.max(0, total - committed),
      realisedPnl: realised,
      openPositions,
      closedTrades,
      winRate: closedTrades ? (wins / closedTrades) * 100 : 0,
      agents: snapshots.map((s) => ({
        id: s.config.id,
        name: s.config.name,
        mode: s.config.mode,
        status: s.config.status,
        allocated: s.config.allocatedCapital,
        equity: s.performance.equity,
        netPnl: s.performance.netPnl,
        openPositions: s.performance.openPositions,
      })),
      updatedAt: Date.now(),
    };
  }

  /**
   * Tradeable markets, from the exchanges the engine actually reads. Cached for
   * a day because the list changes rarely and the call is heavy. A failed
   * refresh keeps the previous list rather than emptying the picker.
   */
  async availableMarkets(): Promise<Record<string, unknown>> {
    const cached = await this.ctx.storage.get<{ symbols: string[]; fetchedAt: number }>("markets");
    if (cached && Date.now() - cached.fetchedAt < 86_400_000) return cached;
    try {
      const symbols = await new MultiExchangeMarketData({ timeoutMs: 10_000 }).getMarkets();
      const usdt = symbols
        .filter((symbol) => symbol.endsWith("USDT"))
        .sort((a, b) => a.localeCompare(b));
      const fresh = { symbols: usdt, fetchedAt: Date.now() };
      await this.ctx.storage.put({ markets: fresh });
      return fresh;
    } catch (error) {
      if (cached) return cached;
      return {
        symbols: [],
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : "Market list unavailable.",
      };
    }
  }

  /**
   * What the engine is doing right now, and whether it is running at all.
   * Reported from the last completed tick rather than recomputed, so opening
   * the page never changes what it reports.
   */
  async liveStatus(): Promise<Record<string, unknown>> {
    const status = await this.ctx.storage.get<Record<string, unknown>>("liveStatus");
    const lastTickAt = (await this.ctx.storage.get<number>("lastTickAt")) ?? null;
    const alarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    const stale = lastTickAt === null || now - lastTickAt > 3 * STEADY_TICK_MS;

    return {
      ...(status ?? { agents: [] }),
      lastTickAt,
      nextTickAt: alarm,
      running: !stale,
      // Said plainly, because "no trades" and "not running" look identical from
      // the outside and mean very different things.
      health: stale
        ? lastTickAt === null
          ? "No analysis has run yet."
          : `No analysis for ${Math.round((now - lastTickAt) / 60_000)} minutes. The loop is being restarted.`
        : "Analysis is running.",
      serverTime: now,
    };
  }

  async marketConditions(): Promise<Record<string, unknown>> {
    return (await this.ctx.storage.get<Record<string, unknown>>("marketConditions")) ?? {
      conditions: [],
      updatedAt: null,
    };
  }

  /** Cached so the feeds are polled on the analysis cadence, not per request. */
  async news(): Promise<NewsResult> {
    const cached = await this.ctx.storage.get<NewsResult>("news");
    if (cached && Date.now() - cached.fetchedAt < 15 * 60_000) return cached;
    const assets = await this.getAssets();
    const fresh = await fetchNews(assets);
    // A failed fetch must not overwrite a good cache with an empty list.
    if (fresh.unavailable && cached) return cached;
    await this.ctx.storage.put({ news: fresh });
    return fresh;
  }

  /**
   * The runtime is held on the Durable Object instance so engines stay warm
   * between ticks. After an eviction it rebuilds itself from stored candles and
   * the persisted engine snapshot.
   */
  private runtime(): TradingRuntime {
    if (!this.runtimeInstance) {
      const storage: RuntimeStorage = {
        get: <T,>(key: string) => this.ctx.storage.get<T>(key),
        put: (entries: Record<string, unknown>) => this.ctx.storage.put(entries),
      };
      this.runtimeInstance = new TradingRuntime(storage);
    }
    return this.runtimeInstance;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "state", payload: await this.getStreamState() }));
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "smc-v1" } });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
  }

  async getStreamState(): Promise<Record<string, unknown>> {
    const [mode, assets, positions, risk, journal, activity, config, autoTrading, safetyBlocked] = await Promise.all([
      this.getMode(), this.getAssets(), this.getPositions(), this.getRisk(), this.getJournal(), this.getActivity(), this.getConfig(), this.isAutoTrading(), this.isSafetyBlocked(),
    ]);
    const analysis = (await this.ctx.storage.get<Record<string, unknown>>("analysis")) ?? { symbol: assets[0] ?? "BTCUSDT", bias: "NEUTRAL", status: "WAITING", setups: [], events: [] };
    const status = { ...baseState(mode, assets), autoTrading, safetyBlocked };
    return { status, analysis, risk, positions: { open: positions.filter((position) => position.status === "OPEN"), all: positions }, journal: { entries: journal }, activity: { events: activity }, config, configuredAssets: assets, timestamp: Date.now() };
  }

  async broadcastState(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const frame = JSON.stringify({ type: "state", payload: await this.getStreamState() });
    for (const socket of sockets) { try { socket.send(frame); } catch { /* stale sockets are cleaned up by the runtime */ } }
  }
  /**
   * Rate limiting is held in memory rather than storage. A Durable Object is a
   * single instance, so the window does not need to survive eviction, and
   * persisting it wrote a storage row on every request.
   */
  private requestTimes: number[] = [];

  async allowRequest(limit = 120, windowMs = 60_000): Promise<boolean> {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter((t) => t > now - windowMs);
    if (this.requestTimes.length >= limit) return false;
    this.requestTimes.push(now);
    return true;
  }

  async ensureAnalysisAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
  }

  /**
   * Restart the analysis loop if it has stopped advancing.
   *
   * Re-arming only when no alarm exists is not enough: an alarm whose handler
   * keeps failing is retried and then dropped, and one scheduled far ahead
   * still counts as present. Either way the agents go quiet until somebody
   * opens the dashboard, which is what made them look like they only ran while
   * being watched. The heartbeat records real progress, so a stale one means
   * the loop is not running whatever the alarm says.
   */
  async reviveIfStalled(): Promise<{ revived: boolean; lastTickAt: number | null; reason?: string }> {
    const lastTickAt = (await this.ctx.storage.get<number>("lastTickAt")) ?? null;
    const alarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    const stallAfter = 3 * STEADY_TICK_MS;

    const neverRan = lastTickAt === null;
    const stalled = lastTickAt !== null && now - lastTickAt > stallAfter;
    const overdue = alarm !== null && alarm < now - stallAfter;

    if (!neverRan && !stalled && !overdue) {
      if (alarm === null) await this.ctx.storage.setAlarm(now + STEADY_TICK_MS);
      return { revived: false, lastTickAt };
    }

    const reason = neverRan
      ? "no analysis has run yet"
      : stalled
        ? `no analysis for ${Math.round((now - (lastTickAt ?? now)) / 60_000)} minutes`
        : "the scheduled alarm is overdue";

    // Replace rather than trust the existing schedule: a stuck alarm is exactly
    // the case this is here to recover from.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.setAlarm(now + 1_000);
    console.warn(JSON.stringify({ event: "analysis_revived", reason, lastTickAt, timestamp: now }));
    return { revived: true, lastTickAt, reason };
  }

  async alarm(): Promise<void> {
    let nextDelay = STEADY_TICK_MS;
    try {
      await this.runAnalysis();
      await this.tickAgents();
      // While any market is still replaying history, come back quickly. Warm-up
      // is limited by CPU per invocation, not wall-clock, so short intervals
      // shorten it from tens of minutes to about a minute.
      // Markets left over only when the per-invocation cap was reached; come
      // back sooner so they are not left behind for a full interval.
      const uncovered = (await this.ctx.storage.get<number>("agentBacklog")) ?? 0;
      const agentsWarming = (await this.ctx.storage.get<boolean>("anyWarming")) || uncovered > 0;
      // Cold-starting the spot watchlist costs its own run of exchange calls
      // (fallback across five exchanges per timeframe on a market with no
      // history yet). Stacked onto an invocation that is also backfilling
      // every agent's markets, that is what pushed this Worker over its
      // per-invocation subrequest ceiling in production. Spot analysis waits
      // for a tick where nothing else is warming, so its own cold start gets
      // the budget to itself rather than fighting agents for it.
      if (!agentsWarming) await this.tickSpot();
      nextDelay = agentsWarming ? WARMING_TICK_MS : STEADY_TICK_MS;
      // Provider probes are only useful at the steady cadence.
      if (nextDelay === STEADY_TICK_MS) await this.probeProviderHealth();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + nextDelay);
    }
  }

  /**
   * Advance every active agent and record the conditions they observed. Agent
   * failures are contained: one agent erroring must not stop the others or the
   * alarm from rescheduling.
   */
  async tickAgents(): Promise<void> {
    await this.ctx.storage.put({ lastTickAt: Date.now() });
    let results;
    try {
      results = await this.agents().tickAll();
    } catch (error) {
      console.error(JSON.stringify({
        event: "agent_tick_failed",
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      }));
      return;
    }
    if (!results.length) return;

    const conditions: Record<string, unknown>[] = [];
    for (const result of results) {
      for (const [symbol, reading] of Object.entries(result.regimes)) {
        conditions.push({ symbol, ...reading });
      }
      console.log(JSON.stringify({
        event: "agent_tick",
        agent: result.name,
        supervisor: result.supervisor.state,
        headline: result.supervisor.headline,
        applied: result.applied.map((a) => `${a.field} ${a.from}->${a.to}`),
        closedTrades: result.performance.closedTrades,
        winRate: Number(result.performance.winRate.toFixed(1)),
        netPnl: Number(result.performance.netPnl.toFixed(2)),
        openPositions: result.performance.openPositions,
        timestamp: Date.now(),
      }));
    }

    // A compact record of what each market actually did, so the interface can
    // show the engine working rather than leaving the operator to infer it from
    // numbers that only move when a position closes.
    const liveStatus = {
      lastTickAt: Date.now(),
      agents: results.map((result) => ({
        id: result.agentId,
        name: result.name,
        supervisor: result.supervisor.state,
        headline: result.supervisor.headline,
        openPositions: result.performance.openPositions,
        markets: result.ticks.map((tick) => ({
          symbol: tick.symbol,
          status: tick.status,
          bias: tick.analysis.bias,
          setups: tick.analysis.setups.length,
          warming: tick.warming,
          executed: tick.executed,
          rejected: tick.rejected,
          reason: tick.analysis.noTradeReason ?? tick.message ?? null,
          blocked: tick.blockedReasons,
          regime: result.regimes[tick.symbol]?.regime ?? null,
        })),
      })),
    };
    await this.ctx.storage.put({ liveStatus });

    const pending = results[0]?.pendingMarkets ?? 0;
    if (pending !== ((await this.ctx.storage.get<number>("agentBacklog")) ?? 0)) {
      await this.ctx.storage.put({ agentBacklog: pending });
    }

    if (conditions.length) {
      const previous = (await this.ctx.storage.get<{ conditions: Record<string, unknown>[] }>("marketConditions"))?.conditions ?? [];
      // Merge by symbol so a rotated tick does not erase conditions for the
      // markets it did not reach this time.
      const merged = new Map(previous.map((c) => [c.symbol as string, c]));
      for (const condition of conditions) merged.set(condition.symbol as string, condition);
      await this.ctx.storage.put({
        marketConditions: { conditions: [...merged.values()], updatedAt: Date.now() },
      });
    }
  }

  async probeProviderHealth(): Promise<void> {
    const probes = [
      ["binance", "https://api.binance.com/api/v3/time"],
      ["bybit", "https://api.bybit.com/v5/market/time"],
      ["coinbase", "https://api.exchange.coinbase.com/time"],
      ["okx", "https://www.okx.com/api/v5/public/time"],
      ["bitget", "https://api.bitget.com/api/v2/public/time"],
      ["kucoin", "https://api.kucoin.com/api/v1/timestamp"],
    ] as const;
    const results = await Promise.all(probes.map(async ([provider, url]) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        return { provider, status: response.ok ? "healthy" : "degraded", code: response.status };
      } catch {
        return { provider, status: "unavailable", code: 0 };
      }
    }));
    await this.ctx.storage.put("providerHealth", { checkedAt: Date.now(), providers: results });
  }

  /**
   * Run the deterministic Smart Money engine for a symbol and publish the
   * result. Every field below is produced by `@smc/core`; nothing here invents
   * a bias, a setup or a fill.
   */
  async runAnalysis(symbolOverride?: string): Promise<Record<string, unknown>> {
    const assets = symbolOverride ? [symbolOverride] : await this.getAssets();
    const symbol = symbolOverride ?? assets[0] ?? "BTCUSDT";
    try {
      const [mode, storedRisk, storedStrategy, autoTrading, safetyBlocked] = await Promise.all([
        this.getMode(),
        this.ctx.storage.get<Record<string, number>>("risk"),
        this.ctx.storage.get<Record<string, unknown>>("strategy"),
        this.isAutoTrading(),
        this.isSafetyBlocked(),
      ]);

      const tick = await this.runtime().tick(symbol, {
        mode,
        risk: { ...DEFAULT_RISK, ...(storedRisk ?? {}) },
        strategy: storedStrategy as Record<string, never> | undefined,
        autoTrading,
        safetyBlocked,
      });

      const engine = this.runtime().engineFor(symbol)!;
      const analysis = serializeAnalysis(tick);

      // Every distinct key written is a billed storage row, so telemetry that
      // used to occupy five keys is kept in one.
      const writes: Record<string, unknown> = {
        analysis: compactAnalysis(analysis),
        feed: {
          lastPrice: lastCloseOf(tick),
          lastPollAt: Date.now(),
          lastError: null,
          provider: tick.exchange,
          providerStatus: "healthy",
        },
      };

      if (!symbolOverride) {
        const positions = engine.getPositions();
        const journal = engine.getJournal().getAll().slice(0, 200);
        const activity = engine.getActivity().getAll().slice(0, 200);
        // Rewriting these on every tick dominated the write budget while
        // nothing about them had changed.
        const signature = `${positions.length}:${journal.length}:${activity.length}:${engine.getRiskState().equity.toFixed(4)}`;
        if (signature !== this.lastEngineSignature) {
          this.lastEngineSignature = signature;
          writes.positions = positions;
          writes.journal = journal;
          writes.activity = activity;

          const equityHistory = (await this.ctx.storage.get<{ timestamp: number; equity: number }[]>("equityHistory")) ?? [];
          const last = equityHistory.at(-1);
          if (!last || Date.now() - last.timestamp >= 60_000) {
            writes.equityHistory = [...equityHistory, { timestamp: Date.now(), equity: engine.getRiskState().equity }].slice(-2_000);
          }
        }
      }

      await this.ctx.storage.put(writes);

      const snaps = tick.analysis.snapshots;
      console.log(JSON.stringify({
        event: "analysis_completed",
        symbol,
        provider: tick.exchange,
        bias: tick.analysis.bias,
        status: tick.status,
        warming: tick.warming,
        executed: tick.executed,
        rejected: tick.rejected,
        setups: tick.analysis.setups.length,
        // Per-timeframe structure, so a neutral bias can be traced to the
        // timeframe responsible instead of guessed at.
        tf: Object.fromEntries(
          Object.entries(snaps)
            .filter(([, snap]) => snap)
            .map(([timeframe, snap]) => [timeframe, {
              candles: snap!.candles.length,
              trend: snap!.structure.trend,
              freshObs: snap!.orderBlocks.filter((b) => b.status === "FRESH").length,
              fvgs: snap!.fvgs.length,
              liquidity: snap!.liquidityZones.length,
            }]),
        ),
        reason: tick.analysis.noTradeReason ?? null,
        blocked: tick.blockedReasons,
        timestamp: Date.now(),
      }));

      await this.persistDurably(tick);

      let anyWarming = tick.warming;
      if (!symbolOverride && assets.length > 1) {
        const scans: Record<string, unknown>[] = [compactAnalysis(analysis)];
        for (const asset of assets.slice(1)) {
          const scan = await this.runAnalysis(asset);
          if (scan.warming === true) anyWarming = true;
          scans.push(compactAnalysis(scan));
        }
        await this.ctx.storage.put({
          analysis: compactAnalysis(analysis),
          marketAnalyses: scans,
        });
      }
      // Drives the alarm cadence: fast while any market replays history. Only
      // written when it actually flips.
      if (!symbolOverride && anyWarming !== this.lastAnyWarming) {
        this.lastAnyWarming = anyWarming;
        await this.ctx.storage.put({ anyWarming });
      }
      if (!symbolOverride) await this.broadcastState();
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market data request failed";
      await this.ctx.storage.put({
        feed: { lastError: message, lastPollAt: Date.now(), provider: "unavailable", providerStatus: "error" },
      });
      console.error(JSON.stringify({ event: "analysis_failed", symbol, message, timestamp: Date.now() }));
      return (await this.ctx.storage.get<Record<string, unknown>>("analysis")) ?? {
        symbol,
        exchange: "multi-exchange",
        bias: "UNCLEAR",
        status: "MARKET_DATA_UNAVAILABLE",
        updatedAt: Date.now(),
        topDown: {
          htf: { timeframe: "4H", trend: "NEUTRAL", strength: "WEAK" },
          mtf: { timeframe: "1H", trend: "NEUTRAL", strength: "WEAK" },
          ltf: { timeframe: "15M", trend: "NEUTRAL" },
        },
        setups: [],
        events: [],
      };
    }
  }

  /** Remember which account this session belongs to, for durable writes. */
  async setUserId(userId: string): Promise<void> {
    if ((await this.ctx.storage.get<string>("userId")) !== userId) {
      await this.ctx.storage.put("userId", userId);
    }
  }

  // ---- session registry -------------------------------------------------
  // A dedicated instance of this class (named "registry") tracks which accounts
  // have an analysis loop, so the cron can re-arm them. Sessions are per user
  // and a cron invocation has no user context of its own.

  async registerSession(userId: string): Promise<void> {
    const users = (await this.ctx.storage.get<string[]>("knownUsers")) ?? [];
    if (!users.includes(userId)) {
      await this.ctx.storage.put("knownUsers", [...users, userId].slice(-1_000));
    }
  }

  async listSessions(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("knownUsers")) ?? [];
  }

  /**
   * Ship whatever is new since the last successful write to MongoDB. Watermarks
   * are only advanced when the write succeeds, so a failed or skipped batch is
   * retried on the next tick rather than silently lost.
   */
  private async persistDurably(tick: AnalysisTick): Promise<void> {
    const userId = await this.ctx.storage.get<string>("userId");
    if (!userId) return;

    const symbol = tick.symbol;
    const watermarkKey = `persisted:candles:${symbol}`;
    const sentSetupsKey = `persisted:setups:${symbol}`;
    const [watermark, sentSetups] = await Promise.all([
      this.ctx.storage.get<Record<string, number>>(watermarkKey),
      this.ctx.storage.get<Record<string, string>>(sentSetupsKey),
    ]);
    const marks = watermark ?? {};
    const seen = sentSetups ?? {};

    // Re-send the newest stored bar per timeframe: it may have closed since the
    // last write. The unique index makes the repeat an upsert, not a duplicate.
    const candles = Object.values(tick.analysis.snapshots)
      .flatMap((snapshot) => snapshot?.candles ?? [])
      .filter((candle) => candle.timestamp >= (marks[candle.timeframe] ?? 0));

    // A setup is re-sent when its status changes, so the stored decision keeps up.
    const setups = tick.analysis.setups.filter((setup) => seen[setup.id] !== setup.status);

    const result = await sendIngest(
      { url: this.env.PLATFORM_API_URL ?? "", secret: this.env.WORKER_AUTH_SECRET ?? "" },
      {
        userId,
        candles,
        setups,
        run: {
          symbol,
          exchange: tick.exchange,
          bias: tick.analysis.bias,
          status: tick.status,
          warming: tick.warming,
          setupsSeen: tick.analysis.setups.length,
          validSetups: tick.analysis.setups.filter((s) => s.status === "VALID").length,
          rejectedSetups: tick.rejected,
          executedSetups: tick.executed,
          timestamp: Date.now(),
        },
      },
    );

    if (!result.sent) {
      if (result.reason && !result.reason.includes("not configured")) {
        console.warn(JSON.stringify({ event: "ingest_failed", symbol, reason: result.reason, timestamp: Date.now() }));
      }
      return;
    }

    for (const candle of candles) {
      marks[candle.timeframe] = Math.max(marks[candle.timeframe] ?? 0, candle.timestamp);
    }
    for (const setup of setups) seen[setup.id] = setup.status;

    await this.ctx.storage.put({
      [watermarkKey]: marks,
      // Bound the map so a long-running session cannot grow it without limit.
      [sentSetupsKey]: Object.fromEntries(Object.entries(seen).slice(-500)),
    });
  }

  /**
   * Chart payload for one symbol/timeframe. Kept out of `/api/analysis` and the
   * WebSocket state frame because candle buffers and zone geometry are far
   * larger than the summary those carry.
   */
  async getChart(symbol: string, timeframe?: string): Promise<Record<string, unknown>> {
    const engine = this.runtime().engineFor(symbol);
    if (!engine) return { symbol, timeframe: timeframe ?? null, available: false, reason: "This market has not been analysed yet." };
    const analysis = engine.analysis.analyze();
    const tf = (timeframe ?? engine.strategyConfig.timeframes.ltf) as keyof typeof analysis.snapshots;
    const snapshot = analysis.snapshots[tf];
    if (!snapshot) return { symbol, timeframe: tf, available: false, reason: "No candles for this timeframe yet." };
    return {
      symbol,
      exchange: analysis.exchange,
      timeframe: tf,
      available: true,
      updatedAt: analysis.updatedAt,
      candles: snapshot.candles,
      structure: snapshot.structure,
      bos: snapshot.bos,
      choch: snapshot.choch,
      sweeps: snapshot.sweeps,
      liquidityZones: snapshot.liquidityZones,
      fvgs: snapshot.fvgs,
      orderBlocks: snapshot.orderBlocks,
      supplyDemand: snapshot.supplyDemand,
      momentum: snapshot.momentum,
      setups: analysis.setups,
      positions: engine.getOpenPositions().filter((p) => p.symbol === symbol),
    };
  }
  async getAnalysis(): Promise<Record<string, unknown>> { return this.runAnalysis(); }
  async getMarketAnalyses(): Promise<Record<string, unknown>[]> { await this.runAnalysis(); return (await this.ctx.storage.get<Record<string, unknown>[]>("marketAnalyses")) ?? [await this.getAnalysis()]; }
  async getPositions(): Promise<Record<string, unknown>[]> { return (await this.ctx.storage.get<Record<string, unknown>[]>("positions")) ?? []; }
  async getActivity(): Promise<Record<string, unknown>[]> { return (await this.ctx.storage.get<Record<string, unknown>[]>("activity")) ?? []; }
  async getJournal(): Promise<Record<string, unknown>[]> { return (await this.ctx.storage.get<Record<string, unknown>[]>("journal")) ?? []; }
  /**
   * Risk state comes from the engine's own risk engine whenever a warm engine
   * exists, so the dashboard reports the numbers that actually gated trades.
   * The persisted snapshot is used only before the first tick of a cold start.
   */
  async getRisk(): Promise<Record<string, unknown>> {
    const assets = await this.getAssets();
    const limits = { ...DEFAULT_RISK, ...((await this.ctx.storage.get<Record<string, number>>("risk")) ?? {}) };
    const engine = this.runtime().engineFor(assets[0] ?? "BTCUSDT");

    if (engine) {
      const state = engine.getRiskState();
      return {
        state: {
          equity: state.equity,
          equityDayStart: state.equityDayStart,
          peakEquity: state.peakEquity,
          tradesToday: state.tradesToday,
          realizedPnlToday: state.realizedPnlToday,
          openPositions: engine.getOpenPositions(),
          usedExposure: state.usedExposure,
          usedCorrelatedExposure: state.usedCorrelatedExposure,
          dailyLossReached: state.dailyLossReached,
          drawdownReached: state.drawdownReached,
        },
        limits,
      };
    }

    const snapshot = await this.ctx.storage.get<{ risk?: Record<string, number>; positions?: unknown[] }>(`engine:${assets[0] ?? "BTCUSDT"}`);
    const risk = snapshot?.risk;
    return {
      state: {
        equity: risk?.equity ?? STARTING_EQUITY,
        equityDayStart: risk?.equityDayStart ?? STARTING_EQUITY,
        peakEquity: risk?.peakEquity ?? STARTING_EQUITY,
        tradesToday: risk?.tradesToday ?? 0,
        realizedPnlToday: risk?.realizedPnlToday ?? 0,
        openPositions: (await this.getPositions()).filter((position) => position.status === "OPEN"),
        usedExposure: risk?.usedExposure ?? 0,
        usedCorrelatedExposure: risk?.usedCorrelatedExposure ?? 0,
        dailyLossReached: Boolean(risk?.dailyLossReached),
        drawdownReached: Boolean(risk?.drawdownReached),
      },
      limits,
    };
  }
  /** Feed telemetry recorded by the most recent analysis tick. */
  async getFeed(): Promise<Record<string, unknown>> {
    return (await this.ctx.storage.get<Record<string, unknown>>("feed")) ?? { lastPollAt: null, lastError: null, provider: "unknown" };
  }

  async getEquityHistory(): Promise<{ timestamp: number; equity: number }[]> { return (await this.ctx.storage.get<{ timestamp: number; equity: number }[]>("equityHistory")) ?? []; }

  /**
   * §60 analytics, measured by the same code the backtester uses so paper,
   * live and historical results are directly comparable.
   */
  async getAnalytics(): Promise<Record<string, unknown>> {
    const [positions, equityCurve, marketAnalyses, analysis] = await Promise.all([
      this.getPositions() as unknown as Promise<ManagedPosition[]>,
      this.getEquityHistory(),
      this.ctx.storage.get<Record<string, unknown>[]>("marketAnalyses"),
      this.ctx.storage.get<Record<string, unknown>>("analysis"),
    ]);

    const sources = marketAnalyses?.length ? marketAnalyses : analysis ? [analysis] : [];
    const setups = sources.flatMap((result) => {
      const symbol = String(result.symbol ?? "");
      return ((result.setups as Setup[] | undefined) ?? []).map((setup) => ({ ...setup, symbol: setup.symbol ?? symbol }));
    });

    return {
      ...computePerformance({
        positions,
        setups,
        equityCurve,
        startingEquity: STARTING_EQUITY,
      }),
      equityCurve,
      updatedAt: Date.now(),
    };
  }

  /** §53 — one position with its full management timeline and originating setup. */
  async getTrade(positionId: string): Promise<Record<string, unknown>> {
    const positions = (await this.getPositions()) as unknown as ManagedPosition[];
    const position = positions.find((item) => item.id === positionId || item.setupId === positionId);
    if (!position) return { found: false, reason: "No position with that identifier." };

    const [marketAnalyses, analysis, journal] = await Promise.all([
      this.ctx.storage.get<Record<string, unknown>[]>("marketAnalyses"),
      this.ctx.storage.get<Record<string, unknown>>("analysis"),
      this.getJournal(),
    ]);
    const sources = marketAnalyses?.length ? marketAnalyses : analysis ? [analysis] : [];
    const setup = sources
      .flatMap((result) => (result.setups as Setup[] | undefined) ?? [])
      .find((item) => item.id === position.setupId);

    return {
      found: true,
      position,
      // The originating setup may have aged out of the current analysis window.
      setup: setup ?? null,
      events: position.events ?? [],
      journal: journal.filter((entry) => {
        const data = entry.data as { setupId?: string; positionId?: string } | undefined;
        return data?.setupId === position.setupId || data?.positionId === position.id;
      }),
    };
  }
  async restorePaperState(state: { positions?: unknown[]; journal?: unknown[]; activity?: unknown[]; equity?: number; updatedAt?: number }): Promise<{ restored: boolean; reason?: string }> {
    const existing = await this.getPositions();
    const existingJournal = await this.getJournal();
    if (existing.length || existingJournal.length) return { restored: false, reason: "The active Worker session already contains paper state." };
    if (!Array.isArray(state.positions) || !Array.isArray(state.journal) || !Array.isArray(state.activity) || !Number.isFinite(state.equity)) {
      throw new Error("A valid MongoDB paper-state snapshot is required.");
    }
    const timestamp = Number.isFinite(state.updatedAt) ? Number(state.updatedAt) : Date.now();
    await this.ctx.storage.put({
      positions: state.positions.slice(0, 500) as Record<string, unknown>[],
      journal: state.journal.slice(0, 500) as Record<string, unknown>[],
      activity: state.activity.slice(0, 500) as Record<string, unknown>[],
      equityHistory: [{ timestamp, equity: Number(state.equity) }],
      restoredAt: Date.now(),
    });
    return { restored: true };
  }
  async getProviderHealth(): Promise<Record<string, unknown>> { return (await this.ctx.storage.get<Record<string, unknown>>("providerHealth")) ?? { provider: "unknown", status: "pending" }; }
  async getConfig(): Promise<Record<string, unknown>> { return { strategy: (await this.ctx.storage.get<Record<string, unknown>>("strategy")) ?? { version: "cloudflare-paper-v1" }, risk: { ...DEFAULT_RISK, ...((await this.ctx.storage.get<Record<string, number>>("risk")) ?? {}) } }; }
  async updateConfig(patch: { strategy?: Record<string, unknown>; risk?: Record<string, number> }): Promise<Record<string, unknown>> { const current = await this.getConfig(); const risk = { ...(current.risk as Record<string, number>), ...(patch.risk ?? {}) }; await this.ctx.storage.put({ risk, strategy: { ...(current.strategy as Record<string, unknown>), ...(patch.strategy ?? {}) } }); return this.getConfig(); }
  /**
   * Historical replay using the real SMC engine. The strategy, risk and
   * position-management code paths are the same ones paper and live trading
   * use, so a backtest here reflects what the engine would actually have done.
   */
  async runBacktest(startTime: number, endTime: number, startingEquity = 10_000): Promise<Record<string, unknown>> {
    const symbol = (await this.getAssets())[0] ?? "BTCUSDT";
    const storedRisk = await this.ctx.storage.get<Record<string, number>>("risk");
    const storedStrategy = await this.ctx.storage.get<Record<string, unknown>>("strategy");
    const runtime = this.runtime();
    const strategyConfig = runtime.strategyConfigFor(symbol, storedStrategy as Record<string, never> | undefined);
    const riskConfig = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, ...(storedRisk ?? {}) });

    // Bound the range: every lower-timeframe candle runs a full engine cycle,
    // and one invocation has a finite CPU budget.
    const ltfMs = TIMEFRAME_DURATION_MS[strategyConfig.timeframes.ltf];
    const estimatedCandles = Math.ceil((endTime - startTime) / ltfMs);
    if (estimatedCandles > MAX_BACKTEST_CANDLES) {
      const maxDays = Math.floor((MAX_BACKTEST_CANDLES * ltfMs) / 86_400_000);
      throw new Error(
        `That range needs about ${estimatedCandles} ${strategyConfig.timeframes.ltf} candles, above the ${MAX_BACKTEST_CANDLES} this deployment replays in one request. Choose a range of roughly ${maxDays} days or fewer.`,
      );
    }

    const result = await runHistoricalBacktest({
      symbol,
      exchange: "multi-exchange",
      strategyConfig,
      riskConfig,
      startTime,
      endTime,
      startingEquity,
      marketData: new MultiExchangeMarketData({ timeoutMs: 10_000 }),
    });

    console.log(JSON.stringify({
      event: "backtest_completed",
      symbol,
      trades: result.stats.totalTrades,
      validSetups: result.validSetups,
      rejectedSetups: result.rejectedSetups,
      netPnl: result.stats.netPnl,
      timestamp: Date.now(),
    }));

    return { ...result, symbol, strategyVersion: strategyConfig.version };
  }
  /**
   * Auto trading defaults to on in PAPER mode. Paper trading risks nothing and
   * observing the engine trade is the entire point of the deployment, so a
   * session that has never been configured should not sit idle. An explicit
   * choice is always respected: turning it off stores `false`, which wins here.
   * Any other mode stays off until deliberately enabled.
   */
  async isAutoTrading(): Promise<boolean> {
    const stored = await this.ctx.storage.get<boolean>("autoTrading");
    if (typeof stored === "boolean") return stored;
    return (await this.getMode()) === "PAPER";
  }
  async isSafetyBlocked(): Promise<boolean> { return (await this.ctx.storage.get<boolean>("safetyBlocked")) ?? false; }
  async setSafetyBlocked(blocked: boolean, reason = "Manual safety control"): Promise<{ safetyBlocked: boolean }> { await this.ctx.storage.put({ safetyBlocked: blocked, safetyReason: reason }); return { safetyBlocked: blocked }; }
  async setAutoTrading(enabled: boolean): Promise<{ enabled: boolean }> { await this.ctx.storage.put("autoTrading", enabled); return { enabled }; }
  async getMode(): Promise<RuntimeMode> {
    return (await this.ctx.storage.get<RuntimeMode>("mode")) ?? "PAPER";
  }

  async setMode(mode: RuntimeMode): Promise<{ mode: RuntimeMode }> {
    if (mode === "LIVE" || !["ANALYSIS_ONLY", "PAPER"].includes(mode)) throw new Error("LIVE trading is not enabled on this deployment.");
    await this.ctx.storage.put({ mode, updatedAt: Date.now() });
    return { mode };
  }

  async getLiveTradingReadiness(): Promise<Record<string, unknown>> {
    return {
      ready: false,
      executionEnabled: false,
      blockers: [
        "Real exchange order adapters are not enabled.",
        "Order idempotency and status reconciliation are required.",
        "A trading-enabled, validated exchange connection is required.",
        "An explicit live-trading approval gate is required.",
      ],
    };
  }

  async getAssets(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("assets")) ?? DEFAULT_ASSETS;
  }

  async setAssets(assets: string[]): Promise<string[]> {
    const normalized = [...new Set(assets.map((asset) => asset.trim().toUpperCase()).filter(Boolean))].slice(0, 30);
    if (!normalized.length) throw new Error("At least one market pair is required.");
    await this.ctx.storage.put({ assets: normalized, updatedAt: Date.now() });
    return normalized;
  }
}

export default {
  /**
   * Cron watchdog. Analysis itself runs in each account's Durable Object alarm,
   * which self-reschedules and gets its own CPU budget per invocation. This
   * handler only re-arms alarms that have stopped, so the engine recovers
   * without waiting for someone to open the dashboard. Doing the analysis here
   * instead would put every account into a single invocation's CPU budget.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const registry = env.TRADING_SESSION.getByName("registry");
      const users = await registry.listSessions();
      for (const userId of users) {
        try {
          await env.TRADING_SESSION.getByName(`user:${userId}`).reviveIfStalled();
        } catch (error) {
          console.error(JSON.stringify({
            event: "alarm_rearm_failed",
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          }));
        }
      }
      console.log(JSON.stringify({ event: "cron_rearm", sessions: users.length, timestamp: Date.now() }));
    })());
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request, env) });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(request, env, { status: "ok", service: "smc-trader-worker", authRequired: true, durableObjectBinding: Boolean(env.TRADING_SESSION), timestamp: Date.now() });

    const userId = await authenticatedUser(request, env);
    if (!userId) return json(request, env, { error: "Authentication is required." }, 401);
    const session = env.TRADING_SESSION.getByName(`user:${userId}`);
    if (!(await session.allowRequest())) return json(request, env, { error: "Rate limit exceeded. Please retry in one minute." }, 429);
    // The cron alarm has no request context, so the session records who it
    // belongs to in order to scope its durable writes.
    await session.setUserId(userId);
    await session.ensureAnalysisAlarm();
    // Let the cron watchdog find this account if its alarm ever stops.
    await env.TRADING_SESSION.getByName("registry").registerSession(userId);
    const [mode, assets] = await Promise.all([session.getMode(), session.getAssets()]);
    const state = baseState(mode, assets);

    if (url.pathname === "/api/events" && request.headers.get("upgrade")?.toLowerCase() === "websocket") return session.fetch(request);

    if (url.pathname === "/api/status" && request.method === "GET") {
      const [analysis, positions, autoTrading, safetyBlocked] = await Promise.all([session.getAnalysis(), session.getPositions(), session.isAutoTrading(), session.isSafetyBlocked()]);
      const feed = (await session.getFeed()) as { lastError?: string | null };
      // Report the feed the engine actually recorded rather than fixed numbers.
      return json(request, env, { ...state, autoTrading, safetyBlocked, analysis, positions, feed: { ...state.feed, ...feed, running: !feed.lastError } });
    }
    if (url.pathname === "/api/assets") {
      if (request.method === "GET") return json(request, env, { assets });
      if (request.method === "PUT") {
        const body = (await request.json().catch(() => ({}))) as { assets?: unknown };
        if (!Array.isArray(body.assets) || !body.assets.every((asset) => typeof asset === "string")) return json(request, env, { error: "assets must be a string array" }, 400);
        try { return json(request, env, { assets: await session.setAssets(body.assets) }); } catch (error) { return json(request, env, { error: String(error) }, 400); }
      }
    }
    if (url.pathname === "/api/mode" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { mode?: RuntimeMode };
      try { return json(request, env, await session.setMode(body.mode as RuntimeMode)); } catch (error) { return json(request, env, { error: error instanceof Error ? error.message : "Invalid mode" }, 400); }
    }

    if (url.pathname === "/api/analysis" && request.method === "GET") return json(request, env, await session.getAnalysis());
    if (url.pathname === "/api/agents") {
      if (request.method === "GET") return json(request, env, await session.listAgents());
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const result = (await session.createAgent(body)) as { error?: string };
        return json(request, env, result, result.error ? 400 : 201);
      }
    }
    if (url.pathname.startsWith("/api/agents/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/agents/".length));
      if (request.method === "PATCH") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const result = (await session.updateAgent(id, body)) as { error?: string };
        return json(request, env, result, result.error ? 400 : 200);
      }
      if (request.method === "DELETE") return json(request, env, await session.deleteAgent(id));
    }
    if (url.pathname === "/api/markets" && request.method === "GET") return json(request, env, await session.availableMarkets());
    if (url.pathname === "/api/live-status" && request.method === "GET") {
      // Opening the page is also a chance to notice the loop has stopped.
      await session.reviveIfStalled();
      return json(request, env, await session.liveStatus());
    }
    if (url.pathname === "/api/portfolio" && request.method === "GET") return json(request, env, await session.portfolio());
    if (url.pathname === "/api/trades" && request.method === "GET") return json(request, env, await session.agentTrades());
    if (url.pathname === "/api/market-conditions" && request.method === "GET") return json(request, env, await session.marketConditions());
    if (url.pathname === "/api/news" && request.method === "GET") return json(request, env, await session.news());
    if (url.pathname === "/api/spot/watchlist" && request.method === "GET") {
      return json(request, env, { symbols: await session.getWatchlist() });
    }
    if (url.pathname === "/api/spot/watchlist" && request.method === "PUT") {
      const body = (await request.json().catch(() => ({}))) as { symbols?: unknown };
      const symbols = Array.isArray(body.symbols) ? body.symbols.filter((s): s is string => typeof s === "string") : [];
      const result = await session.setWatchlist(symbols);
      return json(request, env, result, result.error ? 400 : 200);
    }
    if (url.pathname === "/api/spot/signals" && request.method === "GET") {
      // A trader opening this page for the first time should not have to wait
      // for the next alarm to see anything on a fresh watchlist.
      let { signals, updatedAt } = await session.getSpotSignals();
      if (updatedAt === null) {
        await session.tickSpot();
        ({ signals, updatedAt } = await session.getSpotSignals());
      }
      return json(request, env, { signals, updatedAt });
    }
    if (url.pathname === "/api/capital" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { amount?: number };
      if (!Number.isFinite(body.amount)) return json(request, env, { error: "A numeric amount is required." }, 400);
      return json(request, env, await session.setPaperCapital(Number(body.amount)));
    }
    if (url.pathname === "/api/analytics" && request.method === "GET") return json(request, env, await session.getAnalytics());
    if (url.pathname === "/api/trade" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json(request, env, { error: "A position or setup id is required." }, 400);
      return json(request, env, await session.getTrade(id));
    }
    if (url.pathname === "/api/chart" && request.method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? assets[0] ?? "BTCUSDT";
      return json(request, env, await session.getChart(symbol, url.searchParams.get("timeframe") ?? undefined));
    }
    if (url.pathname === "/api/live-readiness" && request.method === "GET") return json(request, env, await session.getLiveTradingReadiness());
    if (url.pathname === "/api/risk" && request.method === "GET") return json(request, env, await session.getRisk());
    if (url.pathname === "/api/equity-history" && request.method === "GET") return json(request, env, { points: await session.getEquityHistory() });
    if (url.pathname === "/api/paper-state/restore" && request.method === "PUT") {
      const body = (await request.json().catch(() => ({}))) as { positions?: unknown[]; journal?: unknown[]; activity?: unknown[]; equity?: number; updatedAt?: number };
      try { return json(request, env, await session.restorePaperState(body)); } catch (error) { return json(request, env, { error: error instanceof Error ? error.message : "Paper state restoration failed." }, 400); }
    }
    if (url.pathname === "/api/provider-health" && request.method === "GET") return json(request, env, await session.getProviderHealth());
    if (url.pathname === "/api/config") {
      if (request.method === "GET") return json(request, env, await session.getConfig());
      if (request.method === "PATCH") { const body = (await request.json().catch(() => ({}))) as { strategy?: Record<string, unknown>; risk?: Record<string, number> }; return json(request, env, await session.updateConfig(body)); }
    }
    if (url.pathname === "/api/backtest" && request.method === "POST") { const body = (await request.json().catch(() => ({}))) as { startTime?: number; endTime?: number; startingEquity?: number }; if (!Number.isFinite(body.startTime) || !Number.isFinite(body.endTime) || body.endTime! <= body.startTime!) return json(request, env, { error: "A valid start and end time are required." }, 400); try { return json(request, env, await session.runBacktest(body.startTime!, body.endTime!, body.startingEquity)); } catch (error) { return json(request, env, { error: error instanceof Error ? error.message : "Backtest failed" }, 400); } }
    if (url.pathname === "/api/positions" && request.method === "GET") { const positions = await session.getPositions() as unknown as Record<string, unknown>[]; return json(request, env, { open: positions.filter((position) => position.status === "OPEN"), all: positions }); }
    if (url.pathname === "/api/journal" && request.method === "GET") return json(request, env, { entries: await session.getJournal() });
    if (url.pathname === "/api/activity" && request.method === "GET") return json(request, env, { events: await session.getActivity() });
    if (url.pathname === "/api/autotrading" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
      if (typeof body.enabled !== "boolean") return json(request, env, { error: "enabled must be a boolean" }, 400);
      if (mode !== "PAPER" && body.enabled) return json(request, env, { error: "Auto trading is only available in PAPER mode until an exchange is connected." }, 400);
      return json(request, env, await session.setAutoTrading(body.enabled));
    }
    if (url.pathname === "/api/safemode" && request.method === "POST") { const body = (await request.json().catch(() => ({}))) as { reason?: string }; return json(request, env, await session.setSafetyBlocked(true, body.reason)); }
    if (url.pathname === "/api/safemode/exit" && request.method === "POST") return json(request, env, await session.setSafetyBlocked(false));
    if (url.pathname === "/api/connections" && request.method === "GET") return json(request, env, { connections: [], available: false, setupError: "Exchange credentials are not enabled in the Cloudflare paper-trading deployment." });

    return json(request, env, { error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
