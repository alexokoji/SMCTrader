import { describe, expect, it } from "vitest";
import { MarketStructureEngine } from "../src/engines/structure.js";
import { bullishStructure } from "./fixtures.js";

/**
 * CHoCH firing on a reversal is covered in structure.test.ts. This pins the
 * opposite guarantee: a trend that simply continues must never be reported as a
 * change of character, because the confirmation entry model treats a CHoCH as
 * evidence that direction has flipped.
 */
describe("CHoCH is not emitted by trend continuation", () => {
  it("reports breaks of structure but no CHoCH while an uptrend persists", () => {
    const engine = new MarketStructureEngine("BTCUSDT", "test", "4H", {
      strength: 2,
      lookback: 300,
    });

    const choch: unknown[] = [];
    const bos: unknown[] = [];
    for (const candle of bullishStructure("4H")) {
      engine.update(candle);
      const result = engine.evaluate();
      choch.push(...result.choch);
      bos.push(...result.bos);
    }

    expect(engine.getState().trend).toBe("BULLISH");
    expect(bos.length).toBeGreaterThan(0);
    expect(choch).toHaveLength(0);
  });
});
