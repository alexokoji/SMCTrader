/**
 * Premium / Discount of price relative to a structural range.
 * ratio 0 = deep discount (range low), 1 = deep premium (range high).
 */

export interface PremiumDiscountRange {
  high: number;
  low: number;
  /** price at the time the range was measured */
  asOf: number;
}

export function premiumDiscountRatio(price: number, range: PremiumDiscountRange): number {
  const span = range.high - range.low;
  if (span <= 0) return 0.5;
  return Math.min(1, Math.max(0, (price - range.low) / span));
}

export type PdPosition = "PREMIUM" | "DISCOUNT" | "EQUILIBRIUM";

export function pdPosition(ratio: number): PdPosition {
  if (ratio >= 0.5 + 0.05) return "PREMIUM";
  if (ratio <= 0.5 - 0.05) return "DISCOUNT";
  return "EQUILIBRIUM";
}

export function describePd(ratio: number): string {
  const p = pdPosition(ratio);
  if (p === "DISCOUNT") return `Discount (${(ratio * 100).toFixed(0)}% of range)`;
  if (p === "PREMIUM") return `Premium (${(ratio * 100).toFixed(0)}% of range)`;
  return `Equilibrium (${(ratio * 100).toFixed(0)}% of range)`;
}

export function findRange(points: number[]): PremiumDiscountRange {
  let high = -Infinity;
  let low = Infinity;
  for (const p of points) {
    if (p > high) high = p;
    if (p < low) low = p;
  }
  return { high, low, asOf: Date.now() };
}
