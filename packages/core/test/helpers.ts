import type { Candle } from "../src/types/candles.js";
import type { Setup, SetupStatus } from "../src/types/setup.js";
import type { RiskConfig, StrategyConfig } from "../src/config/index.js";
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG } from "../src/config/index.js";

export function testStrategyConfig(overrides?: Partial<StrategyConfig>): StrategyConfig {
  return {
    ...DEFAULT_STRATEGY_CONFIG,
    minRr: 1,
    tp1MinRr: 1,
    entryModels: { aggressive: false, confirmation: true, sweep: false, counterTrend: false },
    ...overrides,
  };
}

export function testRiskConfig(overrides?: Partial<RiskConfig>): RiskConfig {
  return { ...DEFAULT_RISK_CONFIG, ...overrides };
}

let setupCounter = 0;

export function makeSetup(overrides?: Partial<Setup>): Setup {
  const n = setupCounter++;
  const entry = 100 + n;
  const stopLoss = entry - 2;
  const takeProfits = [entry + 6, entry + 10, entry + 14];
  const risk = Math.abs(entry - stopLoss);
  return {
    id: `test-setup-${n}`,
    symbol: "BTCUSDT",
    exchange: "test",
    direction: "LONG",
    timeframe: "15M",
    entryModel: "CONFIRMATION",
    htfTrend: "BULLISH",
    timeframeAnalysis: {
      htf: { timeframe: "4H", trend: "BULLISH", strength: "STRONG" },
      mtf: { timeframe: "1H", trend: "BULLISH", strength: "STRONG" },
      ltf: { timeframe: "15M", trend: "BULLISH" },
    },
    entry,
    stopLoss,
    stopLossReason: "SL below the structural low.",
    takeProfits,
    takeProfitReasons: ["TP1 liquidity", "TP2 liquidity", "TP3 projection"],
    rr: takeProfits.map((t) => Math.abs(t - entry) / risk),
    riskPct: 1,
    score: 80,
    qualityFactors: [],
    hardRules: [{ name: "POI", status: "PASS", detail: "Valid POI." }],
    factors: [],
    reasons: [],
    rejectionReasons: [],
    status: "VALID",
    components: {
      poi: { kind: "ORDER_BLOCK", id: `ob-${n}`, top: 99.5, bottom: 98.5, strength: 0.8, status: "FRESH" },
    },
    counterTrend: false,
    strategyVersion: "test",
    createdAt: 1000 + n,
    ...overrides,
  } as Setup;
}

export function validSetups(count: number): Setup[] {
  return Array.from({ length: count }, () => makeSetup());
}

/** Set a setup's status to a fresh copy to avoid cross-test mutation. */
export function asStatus(setup: Setup, status: SetupStatus): Setup {
  return { ...setup, status };
}

export function feedAll(
  engine: { onCandleClosed(c: Candle): unknown },
  candles: Candle[],
): void {
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (const c of sorted) engine.onCandleClosed(c);
}
