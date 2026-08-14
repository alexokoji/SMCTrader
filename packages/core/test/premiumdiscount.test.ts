import { describe, expect, it } from "vitest";
import {
  describePd,
  findRange,
  pdPosition,
  premiumDiscountRatio,
} from "../src/engines/premiumdiscount.js";

describe("premium / discount", () => {
  const range = { high: 110, low: 90, asOf: 0 };

  it("returns 0 at the range low and 1 at the range high", () => {
    expect(premiumDiscountRatio(90, range)).toBe(0);
    expect(premiumDiscountRatio(110, range)).toBe(1);
  });

  it("returns 0.5 at equilibrium", () => {
    expect(premiumDiscountRatio(100, range)).toBe(0.5);
  });

  it("clamps outside the range", () => {
    expect(premiumDiscountRatio(50, range)).toBe(0);
    expect(premiumDiscountRatio(200, range)).toBe(1);
  });

  it("classifies positions with a 5% equilibrium band", () => {
    expect(pdPosition(0.2)).toBe("DISCOUNT");
    expect(pdPosition(0.8)).toBe("PREMIUM");
    expect(pdPosition(0.5)).toBe("EQUILIBRIUM");
    expect(pdPosition(0.49)).toBe("EQUILIBRIUM");
    expect(pdPosition(0.51)).toBe("EQUILIBRIUM");
  });

  it("describes positions in human readable form", () => {
    expect(describePd(0.2)).toContain("Discount");
    expect(describePd(0.8)).toContain("Premium");
    expect(describePd(0.5)).toContain("Equilibrium");
  });

  it("finds the structural range from a list of prices", () => {
    const r = findRange([100, 95, 103, 90, 110, 98]);
    expect(r.high).toBe(110);
    expect(r.low).toBe(90);
  });

  it("returns 0.5 for a degenerate range", () => {
    expect(premiumDiscountRatio(100, { high: 100, low: 100, asOf: 0 })).toBe(0.5);
  });
});
