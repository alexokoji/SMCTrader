/**
 * Market condition classification.
 *
 * The framework treats context as something you read before you trade, not an
 * indicator you follow. This module turns the structure and volatility the
 * engine already computes into a named regime, so an agent can require
 * conditions that suit its entry models instead of trading everything.
 */
import type { Candle, Trend } from "../types/candles.js";
import { atr } from "../util.js";

export type MarketRegime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGING"
  | "VOLATILE"
  | "QUIET"
  | "UNKNOWN";

export interface RegimeReading {
  regime: MarketRegime;
  /** 0-1: how strongly the evidence supports this classification. */
  confidence: number;
  /** Average true range as a fraction of price. */
  volatilityPct: number;
  /** How far price travelled versus the total path taken, 0-1. */
  efficiency: number;
  detail: string;
}

/**
 * Directional efficiency: net displacement divided by the sum of bar-to-bar
 * movement. A clean trend approaches 1; chop approaches 0. This separates a
 * market that is going somewhere from one that is merely moving.
 */
export function directionalEfficiency(candles: Candle[]): number {
  if (candles.length < 3) return 0;
  const net = Math.abs(candles[candles.length - 1].close - candles[0].close);
  let path = 0;
  for (let i = 1; i < candles.length; i++) {
    path += Math.abs(candles[i].close - candles[i - 1].close);
  }
  return path > 0 ? Math.min(1, net / path) : 0;
}

export interface RegimeThresholds {
  /** Efficiency at or above which price is considered to be trending. */
  trendEfficiency: number;
  /** ATR/price above which conditions count as volatile. */
  highVolatilityPct: number;
  /** ATR/price below which conditions count as quiet. */
  lowVolatilityPct: number;
}

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  trendEfficiency: 0.28,
  highVolatilityPct: 2.5,
  lowVolatilityPct: 0.35,
};

/**
 * Classify recent conditions. `structureTrend` comes from the market structure
 * engine, so the regime agrees with the structure the rest of the system reads
 * rather than deriving a second, competing opinion.
 */
export function classifyRegime(
  candles: Candle[],
  structureTrend: Trend,
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS,
): RegimeReading {
  if (candles.length < 20) {
    return {
      regime: "UNKNOWN",
      confidence: 0,
      volatilityPct: 0,
      efficiency: 0,
      detail: `Only ${candles.length} candles available; at least 20 are needed to classify conditions.`,
    };
  }

  const window = candles.slice(-60);
  const atrs = atr(window, 14);
  const lastAtr = atrs[atrs.length - 1];
  const price = window[window.length - 1].close;
  const volatilityPct = Number.isFinite(lastAtr) && price > 0 ? (lastAtr / price) * 100 : 0;
  const efficiency = directionalEfficiency(window);

  if (volatilityPct >= thresholds.highVolatilityPct) {
    return {
      regime: "VOLATILE",
      confidence: Math.min(1, volatilityPct / (thresholds.highVolatilityPct * 2)),
      volatilityPct,
      efficiency,
      detail: `Average range is ${volatilityPct.toFixed(2)}% of price, above the ${thresholds.highVolatilityPct}% volatile threshold. Stops sized on structure will be wide.`,
    };
  }

  if (volatilityPct > 0 && volatilityPct <= thresholds.lowVolatilityPct) {
    return {
      regime: "QUIET",
      confidence: Math.min(1, thresholds.lowVolatilityPct / Math.max(volatilityPct, 0.01) / 3),
      volatilityPct,
      efficiency,
      detail: `Average range is only ${volatilityPct.toFixed(2)}% of price. Moves are small relative to costs.`,
    };
  }

  if (efficiency >= thresholds.trendEfficiency && (structureTrend === "BULLISH" || structureTrend === "BEARISH")) {
    return {
      regime: structureTrend === "BULLISH" ? "TRENDING_UP" : "TRENDING_DOWN",
      confidence: Math.min(1, efficiency / (thresholds.trendEfficiency * 2)),
      volatilityPct,
      efficiency,
      detail: `Price is travelling with ${(efficiency * 100).toFixed(0)}% efficiency and structure is ${structureTrend.toLowerCase()}. Continuation setups suit these conditions.`,
    };
  }

  return {
    regime: "RANGING",
    confidence: Math.min(1, 1 - efficiency / Math.max(thresholds.trendEfficiency, 0.01)),
    volatilityPct,
    efficiency,
    detail: `Price is retracing most of what it covers (${(efficiency * 100).toFixed(0)}% efficiency). Continuation setups fail more often in these conditions.`,
  };
}

/** Entry models the framework's logic suits to each regime. */
export function modelsSuitedTo(regime: MarketRegime): string[] {
  switch (regime) {
    case "TRENDING_UP":
    case "TRENDING_DOWN":
      return ["CONFIRMATION", "AGGRESSIVE", "SWEEP"];
    case "RANGING":
      return ["SWEEP"];
    case "VOLATILE":
      return ["CONFIRMATION"];
    case "QUIET":
      return [];
    default:
      return [];
  }
}
