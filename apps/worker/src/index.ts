import { DurableObject } from "cloudflare:workers";

interface Env {
  TRADING_SESSION: DurableObjectNamespace<TradingSession>;
  ALLOWED_ORIGIN?: string;
  WORKER_AUTH_SECRET?: string;
}

type RuntimeMode = "ANALYSIS_ONLY" | "PAPER" | "LIVE";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const DEFAULT_RISK = { riskPerTrade: 1, maxDailyLossPct: 3, maxDrawdownPct: 8, maxOpenPositions: 3, maxTradesPerDay: 5, maxLeverage: 1, maxPortfolioExposurePct: 20, maxSymbolExposurePct: 10, maxCorrelatedExposurePct: 15, feePct: 0.1, slippagePct: 0.05 };

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
  const value = request.headers.get("authorization");
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

export class TradingSession extends DurableObject<Env> {
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

  async runAnalysis(symbolOverride?: string): Promise<Record<string, unknown>> {
    const assets = symbolOverride ? [symbolOverride] : await this.getAssets();
    const symbol = assets[0] ?? "BTCUSDT";
    try {
      let closes: number[] | undefined;
      let exchange = "binance";
      try {
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=60`, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`Binance returned ${response.status}`);
        closes = ((await response.json()) as unknown[][]).map((row) => Number(row[4])).filter(Number.isFinite);
      } catch {
        try {
          const response = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=60`, { signal: AbortSignal.timeout(8_000) });
          if (!response.ok) throw new Error(`Binance Vision returned ${response.status}`);
          closes = ((await response.json()) as unknown[][]).map((row) => Number(row[4])).filter(Number.isFinite);
          exchange = "binance-vision";
        } catch {
          try {
            const response = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(symbol)}&interval=60&limit=60`, { signal: AbortSignal.timeout(8_000) });
            if (!response.ok) throw new Error(`Bybit returned ${response.status}`);
            const body = (await response.json()) as { retCode?: number; result?: { list?: string[][] } };
            if (body.retCode !== 0 || !body.result?.list) throw new Error("Bybit returned no candles");
            closes = body.result.list.reverse().map((row) => Number(row[4])).filter(Number.isFinite);
            exchange = "bybit";
          } catch {
            const pair = symbol.replace(/USDT$/, "-USD");
            try {
              const response = await fetch(`https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/candles?granularity=3600`, { signal: AbortSignal.timeout(8_000) });
              if (!response.ok) throw new Error(`Coinbase returned ${response.status}`);
              closes = ((await response.json()) as unknown[][]).reverse().map((row) => Number(row[4])).filter(Number.isFinite);
              exchange = "coinbase";
            } catch {
              const instId = symbol.replace(/USDT$/, "-USDT");
              try {
                const response = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1H&limit=60`, { signal: AbortSignal.timeout(8_000) });
                const body = await response.json() as { code?: string; data?: string[][] };
                if (!response.ok || body.code !== "0" || !body.data) throw new Error("OKX returned no candles");
                closes = body.data.reverse().map((row) => Number(row[4])).filter(Number.isFinite);
                exchange = "okx";
              } catch {
                try {
                  const response = await fetch(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${encodeURIComponent(symbol)}&granularity=1h&limit=60`, { signal: AbortSignal.timeout(8_000) });
                  const body = await response.json() as { code?: string; data?: string[][] };
                  if (!response.ok || body.code !== "00000" || !body.data) throw new Error("Bitget returned no candles");
                  closes = body.data.reverse().map((row) => Number(row[4])).filter(Number.isFinite);
                  exchange = "bitget";
                } catch {
                  const response = await fetch(`https://api.kucoin.com/api/v1/market/candles?symbol=${encodeURIComponent(instId)}&type=1hour`, { signal: AbortSignal.timeout(8_000) });
                  const body = await response.json() as { code?: string; data?: string[][] };
                  if (!response.ok || body.code !== "200000" || !body.data) throw new Error("All market data providers failed, including KuCoin.");
                  closes = body.data.reverse().slice(-60).map((row) => Number(row[2])).filter(Number.isFinite);
                  exchange = "kucoin";
                }
              }
            }
          }
        }
      }
      if (closes.length < 50) throw new Error("Insufficient market candles");
      const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
      const price = closes.at(-1)!;
      const fast = average(closes.slice(-20));
      const slow = average(closes.slice(-50));
      const direction = fast >= slow ? "LONG" : "SHORT";
      const trend = direction === "LONG" ? "BULLISH" : "BEARISH";
      const swing = direction === "LONG" ? Math.min(...closes.slice(-12)) : Math.max(...closes.slice(-12));
      const stopLoss = direction === "LONG" ? Math.min(swing, price * 0.99) : Math.max(swing, price * 1.01);
      const risk = Math.abs(price - stopLoss);
      const takeProfitOne = direction === "LONG" ? price + risk : price - risk;
      const takeProfit = direction === "LONG" ? price + risk * 2 : price - risk * 2;
      const score = Math.min(95, Math.round(60 + (Math.abs(fast - slow) / price) * 10_000));
      const setup = { id: `${symbol}-${Date.now()}`, direction, timeframe: "1h", entryModel: "SMA momentum + structure", entry: price, stopLoss, takeProfits: [takeProfitOne, takeProfit], rr: [1, 2], score, status: score >= 65 ? "QUALIFIED" : "WATCHING", reasons: [`20-period MA ${fast.toFixed(2)} is ${direction === "LONG" ? "above" : "below"} 50-period MA ${slow.toFixed(2)}`, "Public market candles refreshed"], rejectionReasons: [], createdAt: Date.now() };
      const analysis = { symbol, exchange, bias: trend, status: "ANALYZED", updatedAt: Date.now(), topDown: { htf: { timeframe: "4h", trend, strength: "CONFIRMED" }, mtf: { timeframe: "1h", trend, strength: "CONFIRMED" }, ltf: { timeframe: "15m", trend, confirmation: "WAITING" } }, setups: [setup], events: [{ type: "MARKET_ANALYSIS", description: `${symbol} ${trend} analysis refreshed at ${price}`, timestamp: Date.now() }] };
      await this.ctx.storage.put({ analysis, lastPrice: price, lastPollAt: Date.now(), lastError: null, providerHealth: { provider: exchange, status: "healthy", checkedAt: Date.now(), symbol } });
      console.log(JSON.stringify({ event: "analysis_completed", symbol, provider: exchange, bias: trend, timestamp: Date.now() }));
      const existingPositions = (await this.ctx.storage.get<Record<string, unknown>[]>("positions")) ?? [];
      const journal = (await this.ctx.storage.get<Record<string, unknown>[]>("journal")) ?? [];
      const closeFeePct = ((await this.ctx.storage.get<Record<string, number>>("risk"))?.feePct ?? DEFAULT_RISK.feePct) / 100;
      const markedPositions = existingPositions.map((position) => {
        if (position.status !== "OPEN" || position.symbol !== symbol) return position;
        const entry = Number(position.entry); const size = Number(position.positionSize); const isLong = position.direction === "LONG";
        const grossPnl = (isLong ? price - entry : entry - price) * size;
        const exitFee = price * size * closeFeePct;
        const pnl = grossPnl - Number(position.entryFee ?? 0) - exitFee;
        const hitStop = isLong ? price <= Number(position.stopLoss) : price >= Number(position.stopLoss);
        const targets = position.takeProfits as number[];
        const hitFirstTarget = isLong ? price >= Number(targets[0]) : price <= Number(targets[0]);
        if (!position.tp1Taken && hitFirstTarget && targets.length > 1) { const partialSize = size / 2; const allocatedEntryFee = Number(position.entryFee ?? 0) * (partialSize / size); const partialPnl = ((isLong ? price - entry : entry - price) * partialSize) - allocatedEntryFee - price * partialSize * closeFeePct; journal.unshift({ timestamp: Date.now(), symbol, category: "PAPER_TRADE", title: "Partial take-profit", body: `Half position closed for ${partialPnl.toFixed(2)}`, data: { pnl: partialPnl, entryFee: allocatedEntryFee } }); return { ...position, positionSize: partialSize, notional: price * partialSize, currentPrice: price, entryFee: Number(position.entryFee ?? 0) - allocatedEntryFee, realizedPnl: Number(position.realizedPnl ?? 0) + partialPnl, tp1Taken: true, takeProfits: targets.slice(1) }; }
        const hitTarget = isLong ? price >= Number(targets.at(-1)) : price <= Number(targets.at(-1));
        if (!hitStop && !hitTarget) return { ...position, currentPrice: price, unrealizedPnl: pnl };
        const reason = hitStop ? "STOP_LOSS" : "TAKE_PROFIT";
        journal.unshift({ timestamp: Date.now(), symbol, category: "PAPER_TRADE", title: `Paper position closed: ${reason}`, body: `Realized P&L: ${pnl.toFixed(2)}`, data: { pnl, reason } });
        return { ...position, currentPrice: price, unrealizedPnl: 0, realizedPnl: pnl, exitFee, status: "CLOSED", closedAt: Date.now(), closeReason: reason };
      });
      await this.ctx.storage.put({ positions: markedPositions, journal: journal.slice(0, 200) });
      const autoTrading = (await this.ctx.storage.get<boolean>("autoTrading")) ?? false;
      const mode = await this.getMode();
      const safetyBlocked = (await this.ctx.storage.get<boolean>("safetyBlocked")) ?? false;
      if (autoTrading && !safetyBlocked && mode === "PAPER" && score >= 65) {
        const open = markedPositions;
        if (!open.some((position) => position.symbol === symbol && position.status === "OPEN")) {
          const feePct = ((await this.ctx.storage.get<Record<string, number>>("risk"))?.feePct ?? DEFAULT_RISK.feePct) / 100;
          const position = { symbol, direction, setupId: setup.id, entry: price, currentPrice: price, positionSize: 0.01, notional: price * 0.01, entryFee: price * 0.01 * feePct, stopLoss, takeProfits: [takeProfitOne, takeProfit], unrealizedPnl: 0, status: "OPEN", openedAt: Date.now() };
          await this.ctx.storage.put({ positions: [...open, position], activity: [{ kind: "PAPER_ENTRY", symbol, detail: `Paper ${direction} opened from qualified analysis`, level: "info", timestamp: Date.now() }], journal: [{ timestamp: Date.now(), symbol, category: "PAPER_TRADE", title: `Paper ${direction} opened`, body: `Entry ${price}`, data: { entry: price, stopLoss, takeProfit } }, ...journal].slice(0, 200) });
        }
      }
      if (!symbolOverride && assets.length > 1) {
        const scans: Record<string, unknown>[] = [analysis];
        for (const asset of assets.slice(1)) scans.push(await this.runAnalysis(asset));
        await this.ctx.storage.put({ analysis, marketAnalyses: scans });
      }
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market data request failed";
      await this.ctx.storage.put({ lastError: message, lastPollAt: Date.now(), providerHealth: { provider: "unavailable", status: "error", checkedAt: Date.now(), symbol, error: message } });
      console.error(JSON.stringify({ event: "analysis_failed", symbol, message, timestamp: Date.now() }));
      return (await this.ctx.storage.get<Record<string, unknown>>("analysis")) ?? { symbol, exchange: "binance", bias: "NEUTRAL", status: "MARKET_DATA_UNAVAILABLE", updatedAt: Date.now(), topDown: { htf: { timeframe: "4h", trend: "NEUTRAL", strength: "WAITING" }, mtf: { timeframe: "1h", trend: "NEUTRAL", strength: "WAITING" }, ltf: { timeframe: "15m", trend: "NEUTRAL" } }, setups: [], events: [] };
    }
  }

  async getAnalysis(): Promise<Record<string, unknown>> { return this.runAnalysis(); }
  async getMarketAnalyses(): Promise<Record<string, unknown>[]> { await this.runAnalysis(); return (await this.ctx.storage.get<Record<string, unknown>[]>("marketAnalyses")) ?? [await this.getAnalysis()]; }
  async getPositions(): Promise<Record<string, unknown>[]> { return (await this.ctx.storage.get<Record<string, unknown>[]>("positions")) ?? []; }
  async getActivity(): Promise<Record<string, unknown>[]> { return (await this.ctx.storage.get<Record<string, unknown>[]>("activity")) ?? []; }
  async getJournal(): Promise<Record<string, unknown>[]> { return (await this.ctx.storage.get<Record<string, unknown>[]>("journal")) ?? []; }
  async getRisk(): Promise<Record<string, unknown>> {
    const positions = await this.getPositions();
    const open = positions.filter((position) => position.status === "OPEN");
    const realized = positions.filter((position) => position.status === "CLOSED").reduce((sum, position) => sum + Number(position.realizedPnl ?? 0), 0);
    const unrealized = open.reduce((sum, position) => sum + Number(position.unrealizedPnl ?? 0), 0);
    const equity = 10_000 + realized + unrealized;
    const exposure = open.reduce((sum, position) => sum + Number(position.notional ?? 0), 0);
    const limits = { ...DEFAULT_RISK, ...((await this.ctx.storage.get<Record<string, number>>("risk")) ?? {}) };
    const equityHistory = (await this.ctx.storage.get<{ timestamp: number; equity: number }[]>("equityHistory")) ?? [];
    const last = equityHistory.at(-1);
    if (!last || Date.now() - last.timestamp >= 60_000) await this.ctx.storage.put("equityHistory", [...equityHistory, { timestamp: Date.now(), equity }].slice(-2_000));
    return { state: { equity, equityDayStart: 10_000, peakEquity: Math.max(10_000, equity), tradesToday: positions.length, realizedPnlToday: realized, openPositions: open, usedExposure: exposure, usedCorrelatedExposure: exposure, dailyLossReached: realized <= -(10_000 * limits.maxDailyLossPct / 100), drawdownReached: equity <= 10_000 * (1 - limits.maxDrawdownPct / 100) }, limits };
  }
  async getEquityHistory(): Promise<{ timestamp: number; equity: number }[]> { return (await this.ctx.storage.get<{ timestamp: number; equity: number }[]>("equityHistory")) ?? []; }
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
    await session.ensureAnalysisAlarm();
    const [mode, assets] = await Promise.all([session.getMode(), session.getAssets()]);
    const state = baseState(mode, assets);

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
    if (url.pathname === "/api/live-readiness" && request.method === "GET") return json(request, env, await session.getLiveTradingReadiness());
    if (url.pathname === "/api/markets" && request.method === "GET") return json(request, env, { analyses: await session.getMarketAnalyses() });
    if (url.pathname === "/api/risk" && request.method === "GET") return json(request, env, await session.getRisk());
    if (url.pathname === "/api/equity-history" && request.method === "GET") return json(request, env, { points: await session.getEquityHistory() });
    if (url.pathname === "/api/provider-health" && request.method === "GET") return json(request, env, await session.getProviderHealth());
    if (url.pathname === "/api/config") {
      if (request.method === "GET") return json(request, env, await session.getConfig());
      if (request.method === "PATCH") { const body = (await request.json().catch(() => ({}))) as { strategy?: Record<string, unknown>; risk?: Record<string, number> }; return json(request, env, await session.updateConfig(body)); }
    }
    if (url.pathname === "/api/backtest" && request.method === "POST") { const body = (await request.json().catch(() => ({}))) as { startTime?: number; endTime?: number; startingEquity?: number }; if (!Number.isFinite(body.startTime) || !Number.isFinite(body.endTime) || body.endTime! <= body.startTime!) return json(request, env, { error: "A valid start and end time are required." }, 400); try { return json(request, env, await session.runBacktest(body.startTime!, body.endTime!, body.startingEquity)); } catch (error) { return json(request, env, { error: error instanceof Error ? error.message : "Backtest failed" }, 400); } }
    if (url.pathname === "/api/positions" && request.method === "GET") { const positions = await session.getPositions(); return json(request, env, { open: positions, all: positions }); }
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
