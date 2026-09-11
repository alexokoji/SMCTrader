/**
 * The exit policy for automated DeFi spot trading, exactly as specified:
 * a position in profit past a threshold is sold back to the chain's
 * stablecoin; a position in loss is held and watched, not sold, until it
 * recovers — at which point the same profit rule takes it out.
 *
 * What this deliberately does not add on its own: a stop-loss, a max holding
 * time, or an "abandon if this looks dead" exit. Those are common risk
 * controls and each is one field away from here (see `deadPoolExit` below,
 * off by default) — they are not defaulted on because the policy as given
 * was "hold losers and wait," and adding a silent stop-loss would be a
 * different policy wearing the name of this one.
 */

export type ExitAction = "HOLD" | "SELL_TO_STABLE" | "KEEP_MONITORING";

export interface ExitPolicyConfig {
  /** Percent gain over entry required before a position is sold to stable. */
  takeProfitPct: number;
  /**
   * Optional: sell out of a position whose pool liquidity has collapsed by
   * this fraction from what it was at entry, regardless of P/L — the signal
   * a rug pull leaves, where "wait for it to recover" is not a strategy
   * because the liquidity to sell into may no longer exist. Off (undefined)
   * by default, matching the policy as specified: losers are held.
   */
  deadPoolLiquidityDropPct?: number;
}

export const DEFAULT_EXIT_POLICY: ExitPolicyConfig = {
  takeProfitPct: 15,
};

export interface ExitDecision {
  action: ExitAction;
  pnlPct: number;
  reason: string;
}

/**
 * `entryLiquidityUsd`/`currentLiquidityUsd` are only used when
 * `deadPoolLiquidityDropPct` is configured; omit them otherwise.
 */
export function decideExit(
  input: {
    entryPriceUsd: number;
    currentPriceUsd: number;
    entryLiquidityUsd?: number;
    currentLiquidityUsd?: number;
  },
  config: ExitPolicyConfig = DEFAULT_EXIT_POLICY,
): ExitDecision {
  const pnlPct = input.entryPriceUsd > 0
    ? ((input.currentPriceUsd - input.entryPriceUsd) / input.entryPriceUsd) * 100
    : 0;

  if (
    config.deadPoolLiquidityDropPct !== undefined &&
    input.entryLiquidityUsd &&
    input.entryLiquidityUsd > 0 &&
    input.currentLiquidityUsd !== undefined
  ) {
    const drop = ((input.entryLiquidityUsd - input.currentLiquidityUsd) / input.entryLiquidityUsd) * 100;
    if (drop >= config.deadPoolLiquidityDropPct) {
      return {
        action: "SELL_TO_STABLE",
        pnlPct,
        reason: `Pool liquidity fell ${drop.toFixed(0)}% from entry — exiting regardless of P/L.`,
      };
    }
  }

  if (pnlPct >= config.takeProfitPct) {
    return {
      action: "SELL_TO_STABLE",
      pnlPct,
      reason: `Up ${pnlPct.toFixed(1)}% against a ${config.takeProfitPct}% target — selling to stable.`,
    };
  }

  if (pnlPct < 0) {
    return {
      action: "KEEP_MONITORING",
      pnlPct,
      reason: `Down ${Math.abs(pnlPct).toFixed(1)}% — held and monitored until it recovers to the profit target.`,
    };
  }

  return {
    action: "HOLD",
    pnlPct,
    reason: `Up ${pnlPct.toFixed(1)}%, short of the ${config.takeProfitPct}% target.`,
  };
}
