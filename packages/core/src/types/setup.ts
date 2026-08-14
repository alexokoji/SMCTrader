import type { Direction, Timeframe, Trend } from "./candles.js";
import type { ChochEvent } from "./structure.js";
import type { SweepEvent } from "./liquidity.js";

export type EntryModel =
  | "AGGRESSIVE"
  | "CONFIRMATION"
  | "SWEEP"
  | "COUNTER_TREND";

export interface ConfluenceFactor {
  name: string;
  status: "PASS" | "FAIL" | "NEUTRAL";
  detail: string;
}

export type SetupStatus =
  | "VALIDATING"
  | "VALID"
  | "REJECTED"
  | "STALE"
  | "EXECUTED"
  | "INVALIDATED";

export interface TimeframeAnalysis {
  htf: {
    timeframe: Timeframe;
    trend: Trend;
    strength: "STRONG" | "WEAK";
    poi?: string;
    liquidity?: string;
  };
  mtf: {
    timeframe: Timeframe;
    trend: Trend;
    strength: "STRONG" | "WEAK";
  };
  ltf: {
    timeframe: Timeframe;
    trend: Trend;
    confirmation?: string;
  };
  conflict?: string;
}

export interface SetupComponents {
  poi?: {
    kind: string;
    id: string;
    top: number;
    bottom: number;
    strength: number;
    status: string;
  };
  liquidity?: {
    id: string;
    type: "BSL" | "SSL";
    level: number;
    status: string;
  };
  sweepEvent?: SweepEvent;
  chochEvent?: ChochEvent;
  fvgId?: string;
  orderBlockId?: string;
  supplyDemandId?: string;
  premiumDiscount?: {
    position: "PREMIUM" | "DISCOUNT" | "EQUILIBRIUM";
    ratio: number;
  };
  momentum?: {
    label: string;
    score: number;
  };
  inducement?: {
    detected: boolean;
    detail: string;
  };
  targetLiquidity?: {
    type: "BSL" | "SSL";
    level: number;
  };
}

export interface Setup {
  id: string;
  symbol: string;
  exchange: string;
  direction: Direction;
  timeframe: Timeframe;
  entryModel: EntryModel;
  /** structural context at time of creation */
  htfTrend: Trend;
  timeframeAnalysis: TimeframeAnalysis;
  entry: number;
  stopLoss: number;
  stopLossReason: string;
  takeProfits: number[];
  takeProfitReasons: string[];
  rr: number[];
  /** projection: rr[0] >= minRr is a hard rule */
  riskPct: number;
  positionSize?: number;
  score: number;
  qualityFactors: { name: string; status: "PASS" | "FAIL" | "NEUTRAL"; detail: string }[];
  hardRules: { name: string; status: "PASS" | "FAIL" | "NEUTRAL"; detail: string }[];
  factors: ConfluenceFactor[];
  reasons: string[];
  rejectionReasons: string[];
  status: SetupStatus;
  components: SetupComponents;
  counterTrend: boolean;
  strategyVersion: string;
  createdAt: number;
}

export interface RejectedSetup extends Setup {
  status: "REJECTED";
}

export interface SetupQuality {
  score: number;
  components: {
    name: string;
    weight: number;
    value: number;
    detail: string;
  }[];
}
