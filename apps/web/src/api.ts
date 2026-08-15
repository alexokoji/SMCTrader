export interface ApiStatus {
  symbol: string;
  exchange: string;
  marketDataSource?: string;
  timeframes: { htf: string; mtf: string; ltf: string };
  mode: "ANALYSIS_ONLY" | "PAPER" | "LIVE";
  autoTrading: boolean;
  safetyBlocked: boolean;
  strategyVersion: string;
  feed: {
    running: boolean;
    candlesFed: number;
    cyclesProcessed: number;
    lastPollAt: number | null;
    lastPollCandles: number;
    lastError: string | null;
    consecutiveErrors: number;
    safeModeTriggered: boolean;
    perTimeframe: Record<string, number>;
  } | null;
  dayKey: string | null;
}

export type TradingMode = "ANALYSIS_ONLY" | "PAPER" | "LIVE";

export interface ExchangeConnection {
  id: string;
  exchange: string;
  label: string;
  apiKeyMasked: string;
  status: "connected" | "error";
  permissions: { tradingEnabled: boolean; withdrawalEnabled: boolean };
  withdrawalWarning: boolean;
  createdAt: number;
  lastError?: string;
}

export interface Health {
  status: string;
  timestamp: number;
}
export interface AuthUser { id: string; email: string; name: string; }

export interface TopDown {
  htf: { timeframe: string; trend: string; strength: string; poi?: string; liquidity?: string };
  mtf: { timeframe: string; trend: string; strength: string };
  ltf: { timeframe: string; trend: string; confirmation?: string };
  conflict?: string;
}

export interface Setup {
  id: string;
  direction: "LONG" | "SHORT";
  timeframe: string;
  entryModel: string;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  rr: number[];
  score: number;
  status: string;
  reasons: string[];
  rejectionReasons: string[];
  createdAt: number;
  explanation?: {
    headline: string;
    verdict: string;
    lines: { status: string; ok: boolean | null; label: string; detail: string }[];
    reasons: string[];
    rejectionReasons: string[];
    action: string;
  };
}

export interface AnalysisResult {
  symbol: string;
  exchange: string;
  bias: "BULLISH" | "BEARISH" | "RANGING" | "NEUTRAL";
  topDown: TopDown;
  setups: Setup[];
  events: { type: string; description: string; timestamp: number }[];
  status: string;
  updatedAt: number;
}

export interface RiskLimit {
  kind: string;
  limit: number;
  current: number;
  allowed: boolean;
  detail: string;
}

export interface RiskState {
  equity: number;
  equityDayStart: number;
  peakEquity: number;
  tradesToday: number;
  realizedPnlToday: number;
  openPositions: unknown[];
  usedExposure: number;
  usedCorrelatedExposure: number;
  dailyLossReached: boolean;
  drawdownReached: boolean;
}

export interface RiskConfig {
  riskPerTrade: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxLeverage: number;
  maxPortfolioExposurePct: number;
  maxSymbolExposurePct: number;
  maxCorrelatedExposurePct: number;
  feePct: number;
  slippagePct: number;
  [key: string]: number | Record<string, string>;
}

export interface Position {
  symbol: string;
  direction: string;
  setupId: string;
  entry: number;
  currentPrice: number;
  positionSize: number;
  notional: number;
  stopLoss: number;
  takeProfits: number[];
  unrealizedPnl: number;
  status: string;
  openedAt: number;
}

export interface JournalEntry {
  timestamp: number;
  symbol: string;
  category: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ActivityEvent {
  kind: string;
  symbol: string;
  detail: string;
  level: string;
  timestamp: number;
}

export interface BacktestStats {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  netPnl: number;
  maxDrawdown: number;
  [key: string]: number | string;
}

export interface BacktestResult {
  trades: unknown[];
  equityCurve: { timestamp: number; equity: number }[];
  stats: BacktestStats;
  validSetups: number;
  rejectedSetups: number;
  message: string;
}

export interface StreamState {
  status: ApiStatus;
  analysis: AnalysisResult;
  // The API's `limits` field is the active risk configuration, rather than
  // per-trade evaluation results.
  risk: { state: RiskState; limits: RiskConfig };
  positions: { open: Position[]; all: Position[] };
  journal: { entries: JournalEntry[] };
  activity: { events: ActivityEvent[] };
  config: { strategy: Record<string, unknown>; risk: RiskConfig };
  configuredAssets: string[];
  timestamp: number;
}

export interface StreamHandlers {
  onState: (state: StreamState) => void;
  onActivity: (event: ActivityEvent) => void;
  onSystem: (level: string, detail: string) => void;
  onStatus: (connected: boolean) => void;
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const websocketBaseUrl = (import.meta.env.VITE_WS_BASE_URL ?? "").replace(/\/$/, "");
let workerToken: { value: string; expiresAt: number } | undefined;

function apiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

/**
 * Connect to the real-time WebSocket event stream with exponential reconnect
 * backoff. Returns a function that disconnects. See stream.ts on the API side.
 */
export function connectStream(handlers: StreamHandlers): () => void {
  // The Cloudflare compatibility API is request/response based for now. Do not
  // repeatedly open a WebSocket against the Vercel static deployment.
  if (apiBaseUrl && !websocketBaseUrl) {
    handlers.onStatus(false);
    return () => undefined;
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const url = websocketBaseUrl || `${proto}://${window.location.host}/ws`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  function open(): void {
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      handlers.onStatus(true);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          payload?: StreamState;
          event?: ActivityEvent;
          level?: string;
          detail?: string;
        };
        if (msg.type === "state" && msg.payload) handlers.onState(msg.payload);
        else if (msg.type === "activity" && msg.event) handlers.onActivity(msg.event);
        else if (msg.type === "system" && msg.level) handlers.onSystem(msg.level, msg.detail ?? "");
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      handlers.onStatus(false);
      if (closed) return;
      retry += 1;
      setTimeout(open, Math.min(1000 * 2 ** retry, 15000));
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }

  open();
  return () => {
    closed = true;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!workerToken || workerToken.expiresAt < Date.now() + 30_000) {
    const session = await fetch("/api/auth/token", { credentials: "include" });
    if (!session.ok) {
      const body = await session.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Unable to establish a trading session (${session.status}).`);
    }
    const token = await session.json() as { token: string; expiresIn: number };
    workerToken = { value: token.token, expiresAt: Date.now() + token.expiresIn * 1000 };
  }
  const res = await fetch(apiUrl(path), {
    headers: { "content-type": "application/json", authorization: `Bearer ${workerToken.value}` },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

/** Same-origin Vercel authentication; trading requests may still target the Worker. */
async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/auth${path}`, { credentials: "include", headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${res.status} Authentication request failed`);
  }
  return res.json() as Promise<T>;
}

async function connectionRequest<T>(init?: RequestInit): Promise<T> {
  const res = await fetch("/api/connections", { credentials: "include", headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Connection request failed.");
  }
  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    me: () => authRequest<{ user: AuthUser | null }>("/session"),
    register: (email: string, password: string, name: string) => authRequest<{ user: AuthUser }>("/register", { method: "POST", body: JSON.stringify({ email, password, name }) }),
    login: (email: string, password: string) => authRequest<{ user: AuthUser }>("/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    logout: () => authRequest<{ signedOut: boolean }>("/logout", { method: "POST" }),
    google: () => { window.location.assign("/api/auth/google"); },
  },
  health: () => request<Health>("/health"),
  status: () => request<ApiStatus>("/api/status"),
  config: () => request<{ strategy: Record<string, unknown>; risk: RiskConfig }>("/api/config"),
  updateConfig: (patch: { strategy?: Record<string, unknown>; risk?: Partial<RiskConfig> }) =>
    request<{ strategy: Record<string, unknown>; risk: RiskConfig }>("/api/config", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  setMode: (mode: TradingMode) => request<{ mode: TradingMode }>("/api/mode", {
    method: "POST",
    body: JSON.stringify({ mode }),
  }),
  assets: () => request<{ assets: string[] }>("/api/assets"),
  updateAssets: (assets: string[]) => request<{ assets: string[] }>("/api/assets", {
    method: "PUT",
    body: JSON.stringify({ assets }),
  }),
  connections: () => connectionRequest<{ connections: ExchangeConnection[]; available?: boolean; setupError?: string }>(),
  addConnection: (input: { exchange: string; label: string; apiKey: string; apiSecret: string }) =>
    connectionRequest<{ connection: ExchangeConnection }>({ method: "POST", body: JSON.stringify(input) }),
  removeConnection: (id: string) => connectionRequest<{ removed: boolean }>({ method: "DELETE", body: JSON.stringify({ id }), headers: { "content-type": "application/json", "x-connection-id": id } }),
  analysis: () => request<AnalysisResult>("/api/analysis"),
  markets: () => request<{ analyses: AnalysisResult[] }>("/api/markets"),
  risk: () => request<{ state: RiskState; limits: RiskConfig }>("/api/risk"),
  positions: () => request<{ open: Position[]; all: Position[] }>("/api/positions"),
  journal: () => request<{ entries: JournalEntry[] }>("/api/journal"),
  activity: () => request<{ events: ActivityEvent[] }>("/api/activity"),
  setAutoTrading: (enabled: boolean) =>
    request<{ enabled: boolean }>("/api/autotrading", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  enterSafeMode: (reason: string) =>
    request<{ safetyBlocked: boolean }>("/api/safemode", {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  exitSafeMode: () => request<{ safetyBlocked: boolean }>("/api/safemode/exit", { method: "POST" }),
  rollover: () => request<{ rolledOver: boolean; dayKey: string | null }>("/api/rollover", { method: "POST" }),
  backtest: (body: { startTime: number; endTime: number; startingEquity?: number }) =>
    request<BacktestResult>("/api/backtest", { method: "POST", body: JSON.stringify(body) }),
  feed: (candles: unknown[]) =>
    request<{ candles: number; validSetups: number; executed: boolean }>("/api/feed", {
      method: "POST",
      body: JSON.stringify({ candles }),
    }),
};
