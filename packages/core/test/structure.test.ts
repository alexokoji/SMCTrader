import { describe, expect, it } from "vitest";
import { MarketStructureEngine } from "../src/engines/structure.js";
import { bullishStructure, bearishStructure } from "./fixtures.js";

function engineOf(candles: ReturnType<typeof bullishStructure>) {
  const eng = new MarketStructureEngine("BTCUSDT", "test", "4H", {
    strength: 2,
    lookback: 300,
  });
  for (const c of candles) eng.update(c);
  return eng;
}

describe("market structure", () => {
  it("classifies an ascending staircase as bullish", () => {
    const eng = engineOf(bullishStructure("4H"));
    expect(eng.getState().trend).toBe("BULLISH");
    const seq = eng.snapshot().sequence;
    expect(seq).toContain("HH");
    expect(seq).toContain("HL");
  });

  it("classifies a descending staircase as bearish", () => {
    const eng = engineOf(bearishStructure("4H"));
    expect(eng.getState().trend).toBe("BEARISH");
  });

  it("is deterministic across identical inputs", () => {
    const a = engineOf(bullishStructure("4H")).snapshot();
    const b = engineOf(bullishStructure("4H")).snapshot();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("emits a CHoCH when price reverses against the prior structure", () => {
    // ascending (bullish) then a sharp bearish impulse
    const candles = bullishStructure("4H");
    const eng = new MarketStructureEngine("BTCUSDT", "test", "4H", { strength: 2, lookback: 300 });
    for (const c of candles) eng.update(c);
    const lastTime = candles[candles.length - 1].timestamp;
    const dur = 14400000;
    // clear break below the last swing low
    const bearish = {
      symbol: "BTCUSDT",
      exchange: "test",
      timeframe: "4H" as const,
      timestamp: lastTime + dur,
      open: 100,
      high: 100.2,
      low: 85,
      close: 85.5,
      volume: 100,
    };
    eng.update(bearish);
    const ev = eng.evaluate();
    const choch = ev.choch.find((c) => c.direction === "BEARISH");
    expect(choch).toBeDefined();
    expect(choch?.previousTrend).toBe("BULLISH");
    expect(ev.bos.find((b) => b.direction === "BEARISH")).toBeDefined();
  });

  it("ignores non-increasing (out of order) candles", () => {
    const candles = bullishStructure("4H");
    const eng = new MarketStructureEngine("BTCUSDT", "test", "4H", { strength: 2, lookback: 300 });
    for (const c of candles) eng.update(c);
    const countBefore = eng.candlesCount;
    eng.update(candles[0]); // duplicate/older timestamp
    expect(eng.candlesCount).toBe(countBefore);
  });
});
