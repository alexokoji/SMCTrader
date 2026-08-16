import { DurableObject } from "cloudflare:workers";
import { DEFAULT_RISK_CONFIG, computePerformance, type ManagedPosition, type Setup } from "@smc/core";
import { TradingRuntime, type AnalysisTick, type RuntimeStorage } from "./runtime.js";
import { sendIngest } from "./ingest.js";

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
    message: tick.message ?? null,
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
  async allowRequest(limit = 120, windowMs = 60_000): Promise<boolean> {
    const now = Date.now();
    const recent = ((await this.ctx.storage.get<number[]>("requestTimestamps")) ?? []).filter((timestamp) => timestamp > now - windowMs);
    if (recent.length >= limit) {
      await this.ctx.storage.put("requestTimestamps", recent);
      return false;
    }
    recent.push(now);
    await this.ctx.storage.put("requestTimestamps", recent);
    return true;
  }

  async ensureAnalysisAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
  }

  async alarm(): Promise<void> {
    try {
      await this.runAnalysis();
      await this.probeProviderHealth();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
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

      await this.ctx.storage.put({
        analysis,
        lastPrice: lastCloseOf(tick),
        lastPollAt: Date.now(),
        lastError: null,
        providerHealth: { provider: tick.exchange, status: "healthy", checkedAt: Date.now(), symbol },
      });

      // Positions, journal and activity are the engine's, not the Worker's.
      if (!symbolOverride) {
        const positions = engine.getPositions();
        const equity = engine.getRiskState().equity;
        const equityHistory = (await this.ctx.storage.get<{ timestamp: number; equity: number }[]>("equityHistory")) ?? [];
        const last = equityHistory.at(-1);
        await this.ctx.storage.put({
          positions,
          journal: engine.getJournal().getAll().slice(0, 200),
          activity: engine.getActivity().getAll().slice(0, 200),
          ...(!last || Date.now() - last.timestamp >= 60_000
            ? { equityHistory: [...equityHistory, { timestamp: Date.now(), equity }].slice(-2_000) }
            : {}),
        });
      }

      console.log(JSON.stringify({
        event: "analysis_completed",
        symbol,
        provider: tick.exchange,
        bias: tick.analysis.bias,
        status: tick.status,
        warming: tick.warming,
        executed: tick.executed,
        rejected: tick.rejected,
        timestamp: Date.now(),
      }));

      await this.persistDurably(tick);

      if (!symbolOverride && assets.length > 1) {
        const scans: Record<string, unknown>[] = [analysis];
        for (const asset of assets.slice(1)) scans.push(await this.runAnalysis(asset));
        await this.ctx.storage.put({ analysis, marketAnalyses: scans });
      }
      if (!symbolOverride) await this.broadcastState();
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market data request failed";
      await this.ctx.storage.put({
        lastError: message,
        lastPollAt: Date.now(),
        providerHealth: { provider: "unavailable", status: "error", checkedAt: Date.now(), symbol, error: message },
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
  async runBacktest(startTime: number, endTime: number, startingEquity = 10_000): Promise<Record<string, unknown>> {
    const symbol = (await this.getAssets())[0] ?? "BTCUSDT";
    const product = symbol.replace(/USDT$/, "-USD");
    const url = new URL(`https://api.exchange.coinbase.com/products/${product}/candles`);
    url.searchParams.set("granularity", "3600"); url.searchParams.set("start", new Date(startTime).toISOString()); url.searchParams.set("end", new Date(endTime).toISOString());
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Backtest data unavailable: ${response.status}`);
    const closes = ((await response.json()) as unknown[][]).reverse().map((row) => Number(row[4])).filter(Number.isFinite);
    if (closes.length < 55) throw new Error("Backtest range needs at least 55 hourly candles.");
    let equity = startingEquity; let peak = equity; let maxDrawdown = 0; let wins = 0; const trades: Record<string, unknown>[] = []; const curve: { timestamp: number; equity: number }[] = [];
    for (let i = 50; i < closes.length - 6; i += 6) { const fast = closes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20; const slow = closes.slice(i - 50, i).reduce((a, b) => a + b, 0) / 50; const returnPct = ((closes[i + 6] - closes[i]) / closes[i]) * (fast >= slow ? 1 : -1); const pnl = equity * Math.max(-0.01, Math.min(0.02, returnPct)); equity += pnl; if (pnl > 0) wins++; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100); trades.push({ direction: fast >= slow ? "LONG" : "SHORT", entry: closes[i], exit: closes[i + 6], pnl }); curve.push({ timestamp: startTime + i * 3_600_000, equity }); }
    const totalTrades = trades.length; const grossProfit = trades.filter((trade) => Number(trade.pnl) > 0).reduce((sum, trade) => sum + Number(trade.pnl), 0); const grossLoss = Math.abs(trades.filter((trade) => Number(trade.pnl) < 0).reduce((sum, trade) => sum + Number(trade.pnl), 0));
    return { trades, equityCurve: curve, stats: { totalTrades, winRate: totalTrades ? (wins / totalTrades) * 100 : 0, profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? 99 : 0, netPnl: equity - startingEquity, maxDrawdown }, validSetups: totalTrades, rejectedSetups: 0, message: `Replayed ${closes.length} Coinbase hourly candles for ${symbol}.` };
  }
  async isAutoTrading(): Promise<boolean> { return (await this.ctx.storage.get<boolean>("autoTrading")) ?? false; }
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
    const [mode, assets] = await Promise.all([session.getMode(), session.getAssets()]);
    const state = baseState(mode, assets);

    if (url.pathname === "/api/events" && request.headers.get("upgrade")?.toLowerCase() === "websocket") return session.fetch(request);

    if (url.pathname === "/api/status" && request.method === "GET") {
      const [analysis, positions, autoTrading, safetyBlocked] = await Promise.all([session.getAnalysis(), session.getPositions(), session.isAutoTrading(), session.isSafetyBlocked()]);
      return json(request, env, { ...state, autoTrading, safetyBlocked, analysis, positions, feed: { ...state.feed, running: true, candlesFed: 60, cyclesProcessed: 1 } });
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
    if (url.pathname === "/api/markets" && request.method === "GET") return json(request, env, { analyses: await session.getMarketAnalyses() });
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
