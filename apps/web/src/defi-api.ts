/**
 * Client for the DeFi spot API.
 *
 * Every candidate on this page came from scouting, never from typing a pair
 * in — `save` only succeeds against a symbol the scout actually found. The
 * automated bot is a separate surface with its own wallet and its own
 * config; nothing it does requires anything to be saved first.
 */
import { request } from "./api";

export type ChainId = "ethereum" | "bsc" | "polygon" | "arbitrum" | "base";

export interface ScoutCandidate {
  symbol: string;
  network: ChainId;
  poolAddress: string;
  dex: string;
  baseSymbol: string;
  baseTokenAddress: string;
  quoteSymbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volumeUsd24h: number;
  priceChangePct24h: number;
  fdvUsd: number | null;
  turnoverRatio: number;
}

export interface DeFiSetupView {
  direction: string;
  entryModel: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  targetMovesPct: number[];
  nearestTargetPct: number;
  rr: number[];
  score: number;
  reasons: string[];
  createdAt: number;
}

export interface DeFiSignal {
  symbol: string;
  network: ChainId;
  poolAddress: string;
  dex: string;
  baseSymbol: string;
  quoteSymbol: string;
  price: number | null;
  liquidityUsd: number;
  volumeUsd24h: number;
  fdvUsd: number | null;
  bias: string;
  status: string;
  warming: boolean;
  noTradeReason: string | null;
  setup: DeFiSetupView | null;
  updatedAt: number;
}

export interface DeFiAutoConfig {
  enabled: boolean;
  chains: ChainId[];
  allocatedCapitalUsd: number;
  perTradeCapUsd: number;
  maxGasPriceGwei: number;
  slippageBps: number;
  minScore: number;
  exitPolicy: { takeProfitPct: number; deadPoolLiquidityDropPct?: number };
  walletAddress: string | null;
}

export interface DeFiPosition {
  id: string;
  symbol: string;
  network: ChainId;
  poolAddress: string;
  dex: string;
  baseSymbol: string;
  baseTokenAddress: string;
  entryPriceUsd: number;
  entryLiquidityUsd: number;
  amountInUsd: number;
  quantity: string;
  status: "OPEN" | "CLOSED";
  openedAt: number;
  closedAt?: number;
  exitPriceUsd?: number;
  realizedPnlUsd?: number;
  closeReason?: string;
  txHashOpen: string;
  txHashClose?: string;
}

export interface DeFiActivityEvent {
  timestamp: number;
  level: "info" | "warn" | "danger";
  detail: string;
}

export const defiApi = {
  candidates: () => request<{ candidates: ScoutCandidate[]; updatedAt: number | null; chainErrors: { chain: ChainId; reason: string }[] }>("/api/defi/candidates"),
  rescout: () => request<{ candidates: ScoutCandidate[]; chainErrors: { chain: ChainId; reason: string }[] }>("/api/defi/candidates", { method: "POST" }),
  saved: () => request<{ saved: string[] }>("/api/defi/saved"),
  save: (symbol: string) => request<{ saved: string[]; error?: string }>("/api/defi/saved", { method: "POST", body: JSON.stringify({ symbol }) }),
  unsave: (symbol: string) => request<{ saved: string[] }>(`/api/defi/saved/${encodeURIComponent(symbol)}`, { method: "DELETE" }),
  signals: () => request<{ signals: DeFiSignal[]; updatedAt: number | null }>("/api/defi/signals"),
  walletAddress: () => request<{ address: string | null }>("/api/defi/wallet"),
  createWallet: () => request<{ address: string; privateKey: string } | { error: string }>("/api/defi/wallet", { method: "POST" }),
  importWallet: (privateKey: string) => request<{ address: string; error?: string }>("/api/defi/wallet/import", { method: "POST", body: JSON.stringify({ privateKey }) }),
  removeWallet: () => request<{ removed: boolean }>("/api/defi/wallet", { method: "DELETE" }),
  autoConfig: () => request<DeFiAutoConfig>("/api/defi/auto-config"),
  setAutoConfig: (patch: Partial<DeFiAutoConfig>) =>
    request<{ config: DeFiAutoConfig; error?: string }>("/api/defi/auto-config", { method: "PATCH", body: JSON.stringify(patch) }),
  positions: () => request<{ positions: DeFiPosition[] }>("/api/defi/positions"),
  activity: () => request<{ activity: DeFiActivityEvent[] }>("/api/defi/activity"),
};
