import { describe, expect, it } from "vitest";
import { detectSwings } from "../src/engines/swing.js";
import { bullishStructure, bearishStructure } from "./fixtures.js";

describe("swing detection", () => {
  it("detects alternating highs and lows in a bullish staircase", () => {
    const swings = detectSwings(bullishStructure("4H"), { strength: 2 });
    const highs = swings.filter((s) => s.kind === "HIGH");
    const lows = swings.filter((s) => s.kind === "LOW");
    expect(highs.length).toBeGreaterThan(2);
    expect(lows.length).toBeGreaterThan(2);
    // alternating
    for (let i = 1; i < swings.length; i++) {
      expect(swings[i].kind).not.toBe(swings[i - 1].kind);
    }
    // ascending highs and lows
    for (let i = 1; i < highs.length; i++) {
      expect(highs[i].price).toBeGreaterThan(highs[i - 1].price);
    }
    for (let i = 1; i < lows.length; i++) {
      expect(lows[i].price).toBeGreaterThan(lows[i - 1].price);
    }
  });

  it("detects descending highs and lows in a bearish staircase", () => {
    const swings = detectSwings(bearishStructure("4H"), { strength: 2 });
    const highs = swings.filter((s) => s.kind === "HIGH");
    const lows = swings.filter((s) => s.kind === "LOW");
    expect(highs.length).toBeGreaterThan(2);
    for (let i = 1; i < highs.length; i++) {
      expect(highs[i].price).toBeLessThan(highs[i - 1].price);
    }
    for (let i = 1; i < lows.length; i++) {
      expect(lows[i].price).toBeLessThan(lows[i - 1].price);
    }
  });

  it("is deterministic for identical input", () => {
    const a = detectSwings(bullishStructure("1H"), { strength: 2 });
    const b = detectSwings(bullishStructure("1H"), { strength: 2 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("respects the required strength (confirmation bars on each side)", () => {
    const candles = bullishStructure("4H");
    const swings = detectSwings(candles, { strength: 2 });
    for (const sw of swings) {
      const extreme = sw.kind === "HIGH" ? "high" : "low";
      for (let j = sw.index - 2; j <= sw.index + 2; j++) {
        if (j === sw.index) continue;
        if (sw.kind === "HIGH") {
          expect(candles[sw.index].high).toBeGreaterThan(candles[j].high);
        } else {
          expect(candles[sw.index].low).toBeLessThan(candles[j].low);
        }
      }
    }
  });

  it("returns no swings when the candle count is too small", () => {
    expect(detectSwings([], { strength: 2 })).toEqual([]);
  });
});
