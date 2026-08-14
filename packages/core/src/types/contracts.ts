import type { Direction, Side, Timeframe } from "./candles.js";

export interface StrategyOutput {
  symbol: string;
  exchange: string;
  timestamp: number;
  direction: Direction;
  status:
    | "SCANNING"
    | "ANALYZING"
    | "WAITING_FOR_POI"
    | "POI_REACHED"
    | "WAITING_FOR_LIQUIDITY_SWEEP"
    | "WAITING_FOR_CHOCH"
    | "SETUP_VALIDATING"
    | "RISK_CHECK"
    | "READY"
    | "ORDER_SUBMITTED"
    | "ORDER_FILLED"
    | "MANAGING"
    | "CLOSED_PROFIT"
    | "CLOSED_LOSS"
    | "REJECTED"
    | "RISK_BLOCKED"
    | "DAILY_LIMIT_REACHED"
    | "SAFE_MODE"
    | "EXCHANGE_ERROR"
    | "NO_TRADE";
  marketBias: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCLEAR";
  setupType?: string;
  timeframeAnalysis?: {
    htf: { timeframe: Timeframe; trend: string; strength: string };
    mtf: { timeframe: Timeframe; trend: string; strength: string };
    ltf: { timeframe: Timeframe; trend: string };
    conflict?: string;
  };
  liquidity?: string;
  poi?: string;
  confluence?: string[];
  entry?: number;
  stopLoss?: number;
  takeProfits?: number[];
  rr?: number[];
  risk?: number;
  positionSize?: number;
  score?: number;
  reasons: string[];
  rejectionReasons: string[];
  strategyVersion: string;
  setupId?: string;
}

export type TradeDecision =
  | {
      decision: "EXECUTE";
      symbol: string;
      exchange: string;
      side: Side;
      orderType: "LIMIT" | "MARKET";
      entry: number;
      stopLoss: number;
      takeProfits: number[];
      quantity: number;
      riskAmount: number;
      rr: number[];
      setupId: string;
      strategyVersion: string;
      entryModel: string;
    }
  | {
      decision: "REJECT";
      setupId: string;
      reasons: string[];
    };

export type PreflightResult =
  | { pass: true }
  | { pass: false; reason: string };
