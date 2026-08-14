import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  DEFAULT_RISK_CONFIG,
  StrategyEngine,
  defaultStrategyConfigFor,
  validateRiskConfig,
  validateStrategyConfig,
  type Candle,
  type ExchangeAdapter,
  type MarketDataProvider,
  type RiskConfig,
  type StrategyConfig,
  type TradingMode,
  type Timeframe,
} from "@smc/core";
import { runBacktest } from "@smc/core";
import { explainSetup } from "@smc/core";
import { DailyRolloverScheduler } from "./scheduler.js";
import { PollingFeedService } from "./feed.js";
import { ApiEventStream } from "./stream.js";
import {
  ConnectionVault,
  type ConnectionInput,
  type CredentialValidator,
  type ExchangeConnection,
} from "./connections.js";
import type { Collection } from "mongodb";
import type { StoredExchangeConnection } from "./connections.js";
import { MongoAuthService } from "./auth.js";

export interface ApiAppOptions {
  marketData: MarketDataProvider;
  strategy?: StrategyConfig;
  risk?: RiskConfig;
  startingEquity?: number;
  mode?: TradingMode;
  /** Live exchange adapter. Omit to run on the paper adapter. */
  execution?: ExchangeAdapter;
  /** Enable the polling candle feed. Off by default so tests stay deterministic. */
  feed?: boolean | { intervalMs?: number; historyLimit?: number; safeModeThreshold?: number };
  /** Enable the UTC-midnight daily rollover. On by default. */
  dailyRollover?: boolean | { intervalMs?: number };
  /** Configurable list of assets the platform trades, e.g. ["BTC/USDT","ETH/USDT"]. */
  configuredAssets?: string[];
  /** Optional injected exchange credential validator, primarily for testing. */
  credentialValidator?: (exchange: string) => CredentialValidator | undefined;
  exchangeConnections?: Collection<StoredExchangeConnection>;
  auth?: MongoAuthService;
  authRedirectUrl?: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class ApiApp {
  marketData: MarketDataProvider;
  strategyCfg: StrategyConfig;
  riskCfg: RiskConfig;
  engine: StrategyEngine;
  stream: ApiEventStream;
  configuredAssets: string[];
  feed?: PollingFeedService;
  scheduler?: DailyRolloverScheduler;
  server?: Server;
  private vault?: ConnectionVault;
  private vaultError?: string;
  private auth?: MongoAuthService;
  private authRedirectUrl: string;

  constructor(opts: ApiAppOptions) {
    this.auth = opts.auth;
    this.authRedirectUrl = opts.authRedirectUrl ?? "/";
    this.marketData = opts.marketData;
    this.strategyCfg = opts.strategy ?? defaultStrategyConfigFor("BTCUSDT", "binance");
    this.riskCfg = opts.risk ? validateRiskConfig(opts.risk) : DEFAULT_RISK_CONFIG;
    this.engine = new StrategyEngine({
      strategy: this.strategyCfg,
      risk: this.riskCfg,
      mode: opts.mode ?? "PAPER",
      execution: opts.execution,
      startingEquity: opts.startingEquity ?? 10000,
    });
    this.stream = new ApiEventStream();
    // Push every activity event (trades, risk, safe mode, positions...) live.
    this.engine.getActivity().onAdd((ev) => this.stream.broadcastActivity(ev));
    // Configurable list of assets the platform trades, e.g. ["BTC/USDT","ETH/USDT"].
    // Backward-compatible: if empty, defaults to the strategy symbol.
    this.configuredAssets = opts.configuredAssets ?? [this.strategyCfg.symbol];
    try {
      this.vault = new ConnectionVault({
        validator: opts.credentialValidator,
        collection: opts.exchangeConnections,
        onAudit: (event) => this.engine.getActivity().add({
          kind: "exchange",
          symbol: this.strategyCfg.symbol,
          detail: `${event.action}: ${event.detail}`,
          level: event.action.includes("FAILED") ? "danger" : "info",
        }),
      });
    } catch (err) {
      this.vaultError = err instanceof Error ? err.message : String(err);
    }
    const rollover = opts.dailyRollover === undefined ? true : opts.dailyRollover;
    if (rollover) {
      const cfg = typeof rollover === "object" ? rollover : {};
      this.scheduler = new DailyRolloverScheduler({ engine: this.engine, intervalMs: cfg.intervalMs });
    }
    if (opts.feed) {
      const cfg = typeof opts.feed === "object" ? opts.feed : {};
      this.feed = new PollingFeedService({
        engine: this.engine,
        marketData: this.marketData,
        symbol: this.strategyCfg.symbol,
        timeframes: Object.values(this.strategyCfg.timeframes),
        intervalMs: cfg.intervalMs,
        historyLimit: cfg.historyLimit,
        safeModeThreshold: cfg.safeModeThreshold,
        onSafeMode: (reason) => this.engine.enterSafeMode(reason),
        onPollComplete: () => this.stream.broadcastState(this.buildState()),
      });
    }
  }

  async listen(port: number, host = "0.0.0.0"): Promise<Server> {
    await this.vault?.hydrate();
    return new Promise((resolve) => {
      const server = createServer((req, res) => void this.handle(req, res));
      this.server = server;
      this.stream.attach(server);
      this.stream.onClientConnected = (send) => {
        send({ type: "state", payload: this.buildState() });
      };
      server.listen(port, host, () => {
        this.scheduler?.start();
        void this.feed?.start();
        resolve(server);
      });
    });
  }

  get address(): { port: number; host: string } | undefined {
    const a = this.server?.address();
    if (a && typeof a === "object") return { port: a.port, host: a.address };
    return undefined;
  }

  close(): Promise<void> {
    this.feed?.stop();
    this.scheduler?.stop();
    this.stream.stop();
    const server = this.server;
    return new Promise((resolve, reject) => {
      if (!server) return resolve();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private statusPayload(): Record<string, unknown> {
    return {
      symbol: this.strategyCfg.symbol,
      exchange: this.strategyCfg.exchange,
      marketDataSource: this.marketData.name,
      timeframes: this.strategyCfg.timeframes,
      mode: this.engine.getMode(),
      autoTrading: this.engine.isAutoTrading(),
      safetyBlocked: this.engine.isSafetyBlocked(),
      strategyVersion: this.strategyCfg.version,
      feed: this.feed?.getStats() ?? null,
      dayKey: this.scheduler?.dayKey ?? null,
    };
  }

  private analysisPayload() {
    const analysis = this.engine.analysis.analyze();
    return {
      ...analysis,
      setups: analysis.setups.map((s) => ({ ...s, explanation: explainSetup(s) })),
    };
  }

  /**
   * Full real-time state snapshot pushed over the WebSocket stream. Mirrors the
   * dashboard's refresh payload so a client can render purely from `state` events.
   */
  private buildState(): Record<string, unknown> {
    return {
      status: this.statusPayload(),
      analysis: this.analysisPayload(),
      risk: { state: this.engine.getRiskState(), limits: this.engine.riskLimits },
      positions: { open: this.engine.getOpenPositions(), all: this.engine.getPositions() },
      journal: { entries: this.engine.getJournal().getAll().slice(0, 50) },
      activity: { events: this.engine.getActivity().getAll().slice(0, 50) },
      config: { strategy: this.strategyCfg, risk: this.riskCfg },
      configuredAssets: this.configuredAssets,
      timestamp: Date.now(),
    };
  }

  private publishState(): void {
    this.stream.broadcastState(this.buildState());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const seg = url.pathname.split("/").filter(Boolean);
    try {
      if (seg[0] === "health") {
        return this.send(res, 200, { status: "ok", timestamp: Date.now() });
      }
      if (seg[0] !== "api") {
        return this.send(res, 404, { error: `Not found: /${seg.join("/")}` });
      }
      await this.dispatch(req, res, seg.slice(1), url);
    } catch (err) {
      if (err instanceof HttpError) {
        return this.send(res, err.status, { error: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      this.send(res, 500, { error: message });
    }
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    seg: string[],
    url: URL,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const resource = seg[0];

    switch (resource) {
      case "auth":
        return this.dispatchAuth(req, res, seg.slice(1), method, url);

      case "config": {
        if (method === "PATCH") {
          return this.updateConfig(req, res);
        }
        this.requireMethod(res, method, "GET");
        return this.send(res, 200, { strategy: this.strategyCfg, risk: this.riskCfg });
      }

      case "mode": {
        this.requireMethod(res, method, "POST");
        const body = await this.readJson<{ mode?: TradingMode }>(req);
        if (body.mode !== "ANALYSIS_ONLY" && body.mode !== "PAPER" && body.mode !== "LIVE") {
          throw new HttpError(400, "mode must be ANALYSIS_ONLY, PAPER, or LIVE");
        }
        if (body.mode === "LIVE" && !this.vault?.list().some((c) => c.permissions.tradingEnabled)) {
          throw new HttpError(409, "Connect a trading-enabled exchange account before enabling live mode.");
        }
        this.engine.setMode(body.mode);
        this.publishState();
        return this.send(res, 200, { mode: this.engine.getMode() });
      }

      case "assets": {
        if (method === "GET") return this.send(res, 200, { assets: this.configuredAssets });
        this.requireMethod(res, method, "PUT");
        const body = await this.readJson<{ assets?: string[] }>(req);
        const assets = [...new Set((body.assets ?? []).map((asset) => asset.trim().toUpperCase()).filter(Boolean))];
        if (assets.length === 0) throw new HttpError(400, "At least one market pair is required.");
        if (assets.length > 30) throw new HttpError(400, "A maximum of 30 market pairs may be monitored.");
        if (assets.some((asset) => !/^[A-Z0-9]{3,30}(?:\/[A-Z0-9]{3,12})?$/.test(asset))) {
          throw new HttpError(400, "Market pairs must use a format such as BTCUSDT or BTC/USDT.");
        }
        this.configuredAssets = assets;
        this.engine.getActivity().add({ kind: "assets", symbol: this.strategyCfg.symbol, detail: `Market watchlist updated: ${assets.join(", ")}.`, level: "info" });
        this.publishState();
        return this.send(res, 200, { assets: this.configuredAssets });
      }

      case "connections": {
        if (!this.vault) {
          if (method === "GET") {
            return this.send(res, 200, {
              connections: [],
              available: false,
              setupError: this.vaultError ?? "Secure exchange credential storage is not configured.",
            });
          }
          throw new HttpError(503, this.vaultError ?? "Secure exchange credential storage is not configured.");
        }
        if (method === "GET") return this.send(res, 200, { connections: this.vault.list() });
        if (method === "POST") {
          const body = await this.readJson<ConnectionInput>(req);
          const connection: ExchangeConnection = await this.vault.add(body);
          this.publishState();
          return this.send(res, 201, { connection });
        }
        if (method === "DELETE") {
          const id = seg[1];
          if (!id || !(await this.vault.remove(id))) throw new HttpError(404, "Exchange connection not found.");
          this.publishState();
          return this.send(res, 200, { removed: true });
        }
        throw new HttpError(405, "Use GET, POST, or DELETE for exchange connections.");
      }

      case "status":
        this.requireMethod(res, method, "GET");
        return this.send(res, 200, this.statusPayload());

      case "markets":
        this.requireMethod(res, method, "GET");
        return this.send(res, 200, { markets: await this.marketData.getMarkets() });

      case "ticker": {
        this.requireMethod(res, method, "GET");
        const symbol = seg[1] ?? this.strategyCfg.symbol;
        return this.send(res, 200, await this.marketData.getTicker(symbol));
      }

      case "candles": {
        this.requireMethod(res, method, "GET");
        const timeframe = url.searchParams.get("timeframe") as Timeframe | null;
        const start = Number(url.searchParams.get("start") ?? 0);
        const end = Number(url.searchParams.get("end") ?? Date.now());
        const limit = Number(url.searchParams.get("limit") ?? 1000);
        if (!timeframe) return this.send(res, 400, { error: "timeframe required" });
        const candles = await this.marketData.getOHLCV(
          this.strategyCfg.symbol,
          timeframe,
          start,
          end,
          limit,
        );
        return this.send(res, 200, { candles });
      }

      case "feed": {
        this.requireMethod(res, method, "POST");
        const body = await this.readJson<{ candles?: Candle[] }>(req);
        if (!body.candles || body.candles.length === 0) {
          return this.send(res, 400, { error: "candles array required" });
        }
        const cycles = [];
        for (const candle of body.candles) {
          const cycle = this.engine.onCandleClosed(candle);
          if (cycle) cycles.push(cycle);
        }
        await this.engine.flush();
        this.publishState();
        const validTotal = cycles.reduce((a, c) => a + c.validSetups.length, 0);
        const rejectedTotal = cycles.reduce((a, c) => a + c.rejectedSetups.length, 0);
        const executed = cycles.some((c) =>
          c.decisions.some((d) => d.decision === "EXECUTE"),
        );
        return this.send(res, 200, {
          candles: body.candles.length,
          cycles: cycles.length,
          validSetups: validTotal,
          rejectedSetups: rejectedTotal,
          executed,
          last: cycles[cycles.length - 1] ?? null,
        });
      }

      case "analysis":
        this.requireMethod(res, method, "GET");
        return this.send(res, 200, this.analysisPayload());

      case "reevaluate": {
        this.requireMethod(res, method, "POST");
        const body = await this.readJson<{ price?: number }>(req);
        const cycle = this.engine.reevaluate(body.price);
        this.publishState();
        return this.send(res, 200, cycle);
      }

      case "rollover": {
        this.requireMethod(res, method, "POST");
        this.engine.rolloverDay(Date.now());
        this.scheduler?.tick();
        this.publishState();
        return this.send(res, 200, { rolledOver: true, dayKey: this.scheduler?.dayKey ?? null });
      }

      case "risk":
        this.requireMethod(res, method, "GET");
        return this.send(res, 200, {
          state: this.engine.getRiskState(),
          limits: this.engine.riskLimits,
        });

      case "positions":
        this.requireMethod(res, method, "GET");
        return this.send(res, 200, {
          open: this.engine.getOpenPositions(),
          all: this.engine.getPositions(),
        });

      case "journal":
        this.requireMethod(res, method, "GET");
        return this.send(res, 200, { entries: this.engine.getJournal().getAll() });

      case "activity":
        this.requireMethod(res, method, "GET");
        return this.send(res, 200, { events: this.engine.getActivity().getAll() });

      case "autotrading": {
        this.requireMethod(res, method, "POST");
        const body = await this.readJson<{ enabled: boolean }>(req);
        this.engine.setAutoTrading(Boolean(body.enabled));
        this.publishState();
        return this.send(res, 200, { enabled: this.engine.isAutoTrading() });
      }

      case "safemode": {
        this.requireMethod(res, method, "POST");
        if (seg[1] === "exit") {
          this.engine.exitSafeMode();
          this.publishState();
          return this.send(res, 200, { safetyBlocked: false });
        }
        const body = await this.readJson<{ reason?: string }>(req);
        this.engine.enterSafeMode(body.reason ?? "Triggered via API.");
        this.publishState();
        return this.send(res, 200, { safetyBlocked: true });
      }

      case "backtest": {
        this.requireMethod(res, method, "POST");
        const body = await this.readJson<{
          symbol?: string;
          startTime?: number;
          endTime?: number;
          startingEquity?: number;
          strategyConfig?: StrategyConfig;
          riskConfig?: RiskConfig;
        }>(req);
        if (body.startTime === undefined || body.endTime === undefined) {
          return this.send(res, 400, { error: "startTime and endTime are required" });
        }
        const result = await runBacktest({
          symbol: body.symbol ?? this.strategyCfg.symbol,
          exchange: this.strategyCfg.exchange,
          strategyConfig: body.strategyConfig ?? this.strategyCfg,
          riskConfig: body.riskConfig ?? this.riskCfg,
          startTime: body.startTime,
          endTime: body.endTime,
          startingEquity: body.startingEquity ?? 10000,
          marketData: this.marketData,
        });
        return this.send(res, 200, result);
      }

      default:
        return this.send(res, 404, { error: `Not found: ${method} /api/${seg.join("/")}` });
    }
  }

  private async dispatchAuth(req: IncomingMessage, res: ServerResponse, seg: string[], method: string, url: URL): Promise<void> {
    if (!this.auth) throw new HttpError(503, "Authentication is not configured. Set MONGODB_URI to enable it.");
    const action = seg[0];
    if (action === "me") {
      this.requireMethod(res, method, "GET");
      return this.send(res, 200, { user: await this.auth.userForToken(this.sessionToken(req)) ?? null });
    }
    if (action === "register" || action === "login") {
      this.requireMethod(res, method, "POST");
      const body = await this.readJson<{ email?: string; password?: string; name?: string }>(req);
      if (!body.email || !body.password) throw new HttpError(400, "email and password are required.");
      try {
        const session = action === "register" ? await this.auth.register(body.email, body.password, body.name) : await this.auth.login(body.email, body.password);
        return this.send(res, 200, { user: session.user }, { "set-cookie": this.sessionCookie(session.token) });
      } catch (error) {
        throw new HttpError(401, error instanceof Error ? error.message : "Sign-in failed.");
      }
    }
    if (action === "logout") {
      this.requireMethod(res, method, "POST");
      await this.auth.logout(this.sessionToken(req));
      return this.send(res, 200, { signedOut: true }, { "set-cookie": "smc_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax" });
    }
    if (action === "google" && seg[1] !== "callback") {
      this.requireMethod(res, method, "GET");
      const location = await this.auth.createGoogleAuthorizationUrl();
      res.writeHead(302, { location, "cache-control": "no-store" });
      res.end();
      return;
    }
    if (action === "google" && seg[1] === "callback") {
      this.requireMethod(res, method, "GET");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) throw new HttpError(400, "Google did not return a valid authorization response.");
      try {
        const session = await this.auth.loginWithGoogle(code, state);
        res.writeHead(302, { location: this.authRedirectUrl, "set-cookie": this.sessionCookie(session.token), "cache-control": "no-store" });
        res.end();
        return;
      } catch (error) {
        throw new HttpError(401, error instanceof Error ? error.message : "Google sign-in failed.");
      }
    }
    throw new HttpError(404, "Authentication route not found.");
  }

  private sessionToken(req: IncomingMessage): string | undefined {
    const cookie = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith("smc_session="));
    return cookie ? decodeURIComponent(cookie.slice("smc_session=".length)) : undefined;
  }

  private sessionCookie(token: string): string {
    const secure = process.env.AUTH_COOKIE_SECURE === "true" ? "; Secure" : "";
    return `smc_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 14}; SameSite=Lax${secure}`;
  }

  private async updateConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readJson<{
        strategy?: Partial<StrategyConfig>;
        risk?: Partial<RiskConfig>;
      }>(req);
      const strategy = body.strategy ? { ...this.strategyCfg, ...body.strategy } : { ...this.strategyCfg };
      const risk = body.risk ? validateRiskConfig({ ...this.riskCfg, ...body.risk }) : { ...this.riskCfg };

      // Strategy validation rejects structural fields and out-of-range values.
      validateStrategyConfig(strategy);
      this.engine.updateStrategyConfig(strategy);
      this.engine.updateRiskConfig(risk);
      this.strategyCfg = strategy;
      this.riskCfg = risk;
      // Return the authoritative, ceil-clamped config so the UI always sees reality.
      this.publishState();
      return this.send(res, 200, { strategy: this.strategyCfg, risk: this.riskCfg });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(400, message);
    }
  }

  private requireMethod(res: ServerResponse, method: string, expected: string): void {
    if (method !== expected) {
      throw new HttpError(405, `Method ${method} not allowed. Use ${expected}.`);
    }
  }

  private async readJson<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return {} as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error("Invalid JSON body");
    }
  }

  private send(res: ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string> = {}): void {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }
}

export function createApiApp(opts: ApiAppOptions): ApiApp {
  return new ApiApp(opts);
}
