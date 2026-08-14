import type { Direction } from "../types/candles.js";
import type { Setup, SetupStatus } from "../types/setup.js";

/**
 * Deterministic explanation line for a setup. `ok` is the "checkmark" state:
 * true = satisfied, false = failed, null = informational/neutral.
 */
export interface ExplanationLine {
  status: "PASS" | "FAIL" | "NEUTRAL";
  ok: boolean | null;
  label: string;
  detail: string;
}

export interface SetupExplanation {
  setupId: string;
  symbol: string;
  direction: Direction;
  entryModel: string;
  status: SetupStatus;
  verdict: "EXECUTED" | "VALIDATED" | "REJECTED" | "INVALIDATED" | "PENDING";
  headline: string;
  lines: ExplanationLine[];
  reasons: string[];
  rejectionReasons: string[];
  action: string;
}

export function headlineForStatus(status: SetupStatus): {
  headline: string;
  verdict: SetupExplanation["verdict"];
} {
  switch (status) {
    case "EXECUTED":
      return { headline: "Trade placed.", verdict: "EXECUTED" };
    case "VALID":
      return { headline: "Setup validated — all mandatory conditions passed.", verdict: "VALIDATED" };
    case "REJECTED":
      return { headline: "Trade not placed.", verdict: "REJECTED" };
    case "STALE":
      return { headline: "Setup invalidated — the entry is no longer valid.", verdict: "INVALIDATED" };
    case "INVALIDATED":
      return { headline: "Setup invalidated.", verdict: "INVALIDATED" };
    default:
      return { headline: "Setup validating.", verdict: "PENDING" };
  }
}

/**
 * Build a structured, human-readable explanation for a setup from its
 * deterministic hard rules, quality factors and rejection reasons. The
 * trading engine never uses an LLM for these explanations (section 42).
 */
export function explainSetup(setup: Setup): SetupExplanation {
  const { headline, verdict } = headlineForStatus(setup.status);

  const lines: ExplanationLine[] = [];

  for (const rule of setup.hardRules) {
    lines.push({ status: rule.status, ok: rule.status === "PASS" ? true : rule.status === "FAIL" ? false : null, label: rule.name, detail: rule.detail });
  }
  for (const factor of setup.qualityFactors) {
    if (factor.status === "FAIL") {
      lines.push({ status: factor.status, ok: false, label: factor.name, detail: factor.detail });
    }
  }
  for (const factor of setup.qualityFactors) {
    if (factor.status === "PASS" || factor.status === "NEUTRAL") {
      lines.push({ status: factor.status, ok: factor.status === "PASS" ? true : null, label: factor.name, detail: factor.detail });
    }
  }

  if (setup.riskPct > 0 && setup.positionSize !== undefined && setup.positionSize > 0) {
    lines.push({
      status: "PASS",
      ok: true,
      label: "Risk",
      detail: `Risk ${setup.riskPct}% of equity — position size ${setup.positionSize.toFixed(8)}.`,
    });
  }

  const reasons =
    setup.reasons.length > 0
      ? setup.reasons
      : lines.filter((l) => l.ok === true).map((l) => l.detail);

  const rejectionReasons = setup.rejectionReasons.length > 0 ? setup.rejectionReasons : [];

  const action = rejectionReasons[0] ?? (verdict === "EXECUTED" ? "Position opened. Monitoring active." : "All mandatory conditions passed — waiting for execution.");

  return {
    setupId: setup.id,
    symbol: setup.symbol,
    direction: setup.direction,
    entryModel: setup.entryModel,
    status: setup.status,
    verdict,
    headline,
    lines,
    reasons,
    rejectionReasons,
    action,
  };
}

export interface CycleExplanation {
  symbol: string;
  timestamp: number;
  engineStatus: string;
  message?: string;
  setups: SetupExplanation[];
  validCount: number;
  rejectedCount: number;
}

export function explainCycle(input: {
  symbol: string;
  timestamp: number;
  engineStatus: string;
  message?: string;
  setups: Setup[];
}): CycleExplanation {
  const setups = input.setups.map(explainSetup);
  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    engineStatus: input.engineStatus,
    message: input.message,
    setups,
    validCount: setups.filter((s) => s.verdict === "VALIDATED" || s.verdict === "EXECUTED").length,
    rejectedCount: setups.filter((s) => s.verdict === "REJECTED" || s.verdict === "INVALIDATED").length,
  };
}