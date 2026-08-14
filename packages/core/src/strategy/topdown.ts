import type { Timeframe, Trend } from "../types/candles.js";
import type { StructureSnapshot } from "../types/structure.js";

export interface TimeframeBias {
  timeframe: Timeframe;
  trend: Trend;
  strength: "STRONG" | "WEAK";
}

export interface TopDownResult {
  bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCLEAR";
  htf: TimeframeBias;
  mtf: TimeframeBias;
  ltf: TimeframeBias;
  /** null when no contradiction, otherwise human-readable conflict */
  conflict: string | null;
  alignment: number;
}

/**
 * Top-down analysis: derive the market bias from the higher timeframe and
 * detect contradictions with lower timeframes. A contradiction does not
 * automatically reject trading, but it requires confirmation in the HTF
 * direction before an entry is valid.
 */
export function topDownAnalysis(
  htf: TimeframeBias,
  mtf: TimeframeBias,
  ltf: TimeframeBias,
): TopDownResult {
  let bias: TopDownResult["bias"];
  if (htf.trend === "BULLISH") bias = "BULLISH";
  else if (htf.trend === "BEARISH") bias = "BEARISH";
  else if (htf.trend === "RANGING") bias = "NEUTRAL";
  else bias = "UNCLEAR";

  let conflict: string | null = null;
  if (bias === "BULLISH") {
    if (mtf.trend === "BEARISH" && mtf.strength === "STRONG") {
      conflict = "Mid-timeframe structure is strongly bearish against the bullish higher timeframe.";
    } else if (ltf.trend === "BEARISH" && ltf.strength === "STRONG") {
      conflict = "Lower timeframe structure is strongly bearish. Waiting for a lower-timeframe bullish shift.";
    }
  } else if (bias === "BEARISH") {
    if (mtf.trend === "BULLISH" && mtf.strength === "STRONG") {
      conflict = "Mid-timeframe structure is strongly bullish against the bearish higher timeframe.";
    } else if (ltf.trend === "BULLISH" && ltf.strength === "STRONG") {
      conflict = "Lower timeframe structure is strongly bullish. Waiting for a lower-timeframe bearish shift.";
    }
  }

  let alignment = 0;
  if (bias === "BULLISH" || bias === "BEARISH") {
    const dir = bias === "BULLISH" ? "BULLISH" : "BEARISH";
    if (htf.trend === dir) alignment++;
    if (mtf.trend === dir) alignment++;
    if (ltf.trend === dir) alignment++;
  }

  return {
    bias,
    htf,
    mtf,
    ltf,
    conflict,
    alignment,
  };
}

export function snapshotToBias(
  snapshot: StructureSnapshot,
  timeframe: Timeframe,
): TimeframeBias {
  return {
    timeframe,
    trend: snapshot.trend,
    strength: snapshot.strength,
  };
}
