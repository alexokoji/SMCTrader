/**
 * Client for the agent-centric API.
 *
 * Every value here is produced by the engine or the supervisor. Nothing is
 * computed in the browser: if a number is not reported, the UI shows that it is
 * missing rather than inventing one.
 */
import { request } from "./api";

export type AgentMode = "PAPER" | "LIVE";
export type AgentStatus = "ACTIVE" | "PAUSED" | "STOPPED" | "SUPERVISOR_PAUSED";
export type SupervisorState = "HEALTHY" | "OBSERVING" | "TIGHTENING" | "PAUSED";

export interface AgentConfig {
  id: string;
  name: string;
  mode: AgentMode;
  allocatedCapital: number;
  symbols: string[];
  timeframes: { htf: string; mtf: string; ltf: string };
  entryModels: string[];
  baseline: { riskPerTrade: number; minRr: number; minScore: number };
  working: { riskPerTrade: number; minRr: number; minScore: number };
  requiredRegimes: string[];
  maxOpenPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface AgentPerformance {
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  consecutiveLosses: number;
  drawdownPct: number;
  equity: number;
  openPositions: number;
}

export interface AgentAdjustment {
  field: "minRr" | "minScore" | "riskPerTrade";
  from: number;
  to: number;
  reason: string;
  at?: number;
}

export interface SupervisorVerdict {
  state: SupervisorState;
  headline: string;
  observations: string[];
  adjustments: AgentAdjustment[];
}

export interface AgentSnapshot {
  config: AgentConfig;
  performance: AgentPerformance;
  supervisor: SupervisorVerdict;
  adjustmentHistory: AgentAdjustment[];
}

export interface AgentsResponse {
  agents: AgentSnapshot[];
  capital: { total: number; committed: number };
}

export interface Portfolio {
  totalCapital: number;
  committed: number;
  uncommitted: number;
  equity: number;
  realisedPnl: number;
  openPositions: number;
  closedTrades: number;
  winRate: number;
  agents: {
    id: string;
    name: string;
    mode: AgentMode;
    status: AgentStatus;
    allocated: number;
    equity: number;
    netPnl: number;
    openPositions: number;
  }[];
  updatedAt: number;
}

export interface AgentTrade {
  id: string;
  agentId: string;
  agentName: string;
  symbol: string;
  direction: string;
  entryModel?: string;
  entry: number;
  currentPrice: number;
  stopLoss: number;
  sl: number;
  takeProfits: number[];
  positionSize: number;
  notional: number;
  status: "OPEN" | "CLOSED";
  closeReason?: string;
  finalPnl?: number;
  realizedPnl: number;
  unrealizedPnl: number;
  entryFee: number;
  openedAt: number;
  closedAt?: number;
  plannedRr?: number[];
  mae: number;
  mfe: number;
}

export interface MarketCondition {
  symbol: string;
  regime: string;
  confidence: number;
  volatilityPct: number;
  efficiency: number;
  detail: string;
}

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  symbols: string[];
  sentiment: "NEGATIVE" | "NEUTRAL" | "POSITIVE";
}

export interface NewsResult {
  items: NewsItem[];
  fetchedAt: number;
  sources: { name: string; ok: boolean; detail?: string }[];
  unavailable: boolean;
}

export interface CreateAgentInput {
  name: string;
  mode: AgentMode;
  allocatedCapital: number;
  symbols: string[];
  entryModels?: string[];
  riskPerTrade?: number;
  minRr?: number;
}

export interface MarketsResponse {
  symbols: string[];
  fetchedAt: number;
  error?: string;
}

export const agentsApi = {
  list: () => request<AgentsResponse>("/api/agents"),
  markets: () => request<MarketsResponse>("/api/markets"),
  create: (input: CreateAgentInput) =>
    request<{ agent?: AgentConfig; error?: string }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, patch: Partial<Pick<AgentConfig, "name" | "status" | "allocatedCapital" | "symbols" | "entryModels">>) =>
    request<{ agent?: AgentConfig; error?: string }>(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<{ removed: boolean }>(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  portfolio: () => request<Portfolio>("/api/portfolio"),
  trades: () => request<{ trades: AgentTrade[] }>("/api/trades"),
  conditions: () =>
    request<{ conditions: MarketCondition[]; updatedAt: number | null }>("/api/market-conditions"),
  news: () => request<NewsResult>("/api/news"),
  setCapital: (amount: number) =>
    request<{ total: number }>("/api/capital", { method: "POST", body: JSON.stringify({ amount }) }),
};
