import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG, validateStrategyConfig } from "../src/config/index.js";

/**
 * A trade is judged by the target it is aiming at. Earlier targets are partial
 * exits along the way and carry their own, lower, threshold. Comparing the
 * first target against the trade minimum rejected setups whose final objective
 * comfortably met it, which is why nothing ever traded.
 */
describe("reward-to-risk thresholds", () => {
  it("ships defaults where TP1 is nearer than the final objective", () => {
    expect(DEFAULT_STRATEGY_CONFIG.tp1MinRr).toBeLessThan(DEFAULT_STRATEGY_CONFIG.minRr);
    expect(DEFAULT_STRATEGY_CONFIG.minRr).toBe(3);
    expect(DEFAULT_STRATEGY_CONFIG.tp1MinRr).toBe(1.5);
  });

  it("accepts the shipped defaults, which the inverted check used to reject", () => {
    expect(() => validateStrategyConfig(DEFAULT_STRATEGY_CONFIG)).not.toThrow();
  });

  it("rejects a first-target minimum beyond the trade minimum", () => {
    expect(() =>
      validateStrategyConfig({ ...DEFAULT_STRATEGY_CONFIG, minRr: 3, tp1MinRr: 4 }),
    ).toThrow(/cannot exceed minRr/);
  });

  it("allows TP1 and the final objective to coincide", () => {
    expect(() =>
      validateStrategyConfig({ ...DEFAULT_STRATEGY_CONFIG, minRr: 3, tp1MinRr: 3 }),
    ).not.toThrow();
  });

  it("rejects a non-positive first-target minimum", () => {
    expect(() =>
      validateStrategyConfig({ ...DEFAULT_STRATEGY_CONFIG, tp1MinRr: 0 }),
    ).toThrow(/greater than zero/);
  });

  it("still enforces the platform floor on the trade minimum", () => {
    expect(() =>
      validateStrategyConfig({ ...DEFAULT_STRATEGY_CONFIG, minRr: 0.1, tp1MinRr: 0.1 }),
    ).toThrow(/platform minimum/);
  });
});
