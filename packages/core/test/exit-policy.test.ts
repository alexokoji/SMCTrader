import { describe, expect, it } from "vitest";
import { decideExit, DEFAULT_EXIT_POLICY } from "../src/defi/exit-policy.js";

describe("DeFi spot exit policy", () => {
  it("sells to stable once the take-profit target is reached", () => {
    const decision = decideExit({ entryPriceUsd: 1, currentPriceUsd: 1.16 });
    expect(decision.action).toBe("SELL_TO_STABLE");
    expect(decision.pnlPct).toBeCloseTo(16, 6);
  });

  it("holds a position in profit but short of the target", () => {
    const decision = decideExit({ entryPriceUsd: 1, currentPriceUsd: 1.05 });
    expect(decision.action).toBe("HOLD");
  });

  it("keeps monitoring a position in loss rather than selling it", () => {
    const decision = decideExit({ entryPriceUsd: 1, currentPriceUsd: 0.7 });
    expect(decision.action).toBe("KEEP_MONITORING");
    expect(decision.pnlPct).toBeCloseTo(-30, 6);
  });

  it("takes a recovered position out once it crosses the profit target, same as any other", () => {
    // The exact "hold, then take out once it turns profitable" path: a
    // position that was down is now up past the threshold.
    const decision = decideExit({ entryPriceUsd: 1, currentPriceUsd: 1.20 });
    expect(decision.action).toBe("SELL_TO_STABLE");
  });

  it("does not sell a loser even close to the take-profit threshold on the wrong side of zero", () => {
    const decision = decideExit({ entryPriceUsd: 1, currentPriceUsd: 0.99999 });
    expect(decision.action).toBe("KEEP_MONITORING");
  });

  it("respects a custom take-profit percent", () => {
    const decision = decideExit({ entryPriceUsd: 1, currentPriceUsd: 1.06 }, { takeProfitPct: 5 });
    expect(decision.action).toBe("SELL_TO_STABLE");
  });

  it("never exits on a dead-pool basis unless configured to", () => {
    const decision = decideExit(
      { entryPriceUsd: 1, currentPriceUsd: 0.5, entryLiquidityUsd: 100_000, currentLiquidityUsd: 1_000 },
      DEFAULT_EXIT_POLICY,
    );
    expect(decision.action).toBe("KEEP_MONITORING");
  });

  it("exits a collapsed pool when the dead-pool guard is configured, even while at a loss", () => {
    const decision = decideExit(
      { entryPriceUsd: 1, currentPriceUsd: 0.5, entryLiquidityUsd: 100_000, currentLiquidityUsd: 1_000 },
      { takeProfitPct: 15, deadPoolLiquidityDropPct: 80 },
    );
    expect(decision.action).toBe("SELL_TO_STABLE");
    expect(decision.reason).toMatch(/liquidity/i);
  });

  it("does not trip the dead-pool guard on an ordinary liquidity dip", () => {
    const decision = decideExit(
      { entryPriceUsd: 1, currentPriceUsd: 0.9, entryLiquidityUsd: 100_000, currentLiquidityUsd: 90_000 },
      { takeProfitPct: 15, deadPoolLiquidityDropPct: 80 },
    );
    expect(decision.action).toBe("KEEP_MONITORING");
  });
});
