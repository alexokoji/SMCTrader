import type { Setup } from "../types/setup.js";

export interface ScoreInput {
  alignment: number;
  ht: "STRONG" | "WEAK";
  poiStrength: number;
  poiStatus: string;
  fvgFresh: boolean;
  obFresh: boolean;
  sweepQuality: number;
  discountDepth: number;
  momentumScore: number;
  rrDepth: number;
  targetLiquidity: number;
  chochConfirmed: boolean;
}

export interface ScoreComponent {
  name: string;
  weight: number;
  value: number;
  detail: string;
}

export function scoreSetup(input: ScoreInput): { score: number; components: ScoreComponent[] } {
  const components: ScoreComponent[] = [
    {
      name: "Multi-timeframe alignment",
      weight: 0.18,
      value: input.alignment / 3,
      detail: `${input.alignment}/3 timeframes aligned`,
    },
    {
      name: "Higher timeframe strength",
      weight: 0.1,
      value: input.ht === "STRONG" ? 1 : 0.5,
      detail: `HTF structure ${input.ht}`,
    },
    {
      name: "POI quality",
      weight: 0.15,
      value: Math.min(1, input.poiStrength),
      detail: input.poiStatus === "FRESH" ? "Fresh POI" : "Mitigated POI",
    },
    {
      name: "Entry model confirmation",
      weight: 0.12,
      value: input.chochConfirmed ? 1 : 0.6,
      detail: input.chochConfirmed ? "CHoCH confirmed" : "Pending confirmation",
    },
    {
      name: "Liquidity context",
      weight: 0.12,
      value: Math.min(1, input.sweepQuality + input.targetLiquidity * 0.4),
      detail: `Sweep ${(input.sweepQuality * 100).toFixed(0)}% / target liquidity present`,
    },
    {
      name: "Order block / FVG",
      weight: 0.1,
      value: (input.obFresh ? 0.5 : 0) + (input.fvgFresh ? 0.5 : 0),
      detail: `OB ${input.obFresh ? "fresh" : "absent/mitigated"}, FVG ${input.fvgFresh ? "fresh" : "absent/mitigated"}`,
    },
    {
      name: "Premium / discount",
      weight: 0.08,
      value: input.discountDepth,
      detail: `Discount depth ${(input.discountDepth * 100).toFixed(0)}%`,
    },
    {
      name: "Momentum",
      weight: 0.05,
      value: input.momentumScore,
      detail: `Momentum ${(input.momentumScore * 100).toFixed(0)}%`,
    },
    {
      name: "Reward quality",
      weight: 0.1,
      value: Math.min(1, input.rrDepth),
      detail: `RR depth ${input.rrDepth.toFixed(2)}`,
    },
  ];

  let score = 0;
  for (const c of components) {
    score += c.weight * c.value * 100;
  }
  return { score: Math.round(Math.min(100, Math.max(0, score))), components };
}

export function setupScore(s: Setup): number {
  return s.score;
}
