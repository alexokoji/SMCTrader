import { describe, expect, it } from "vitest";
import { FvgEngine } from "../src/engines/fvg.js";
import { mkCandle } from "./fixtures.js";

function candles(moves: Array<[number, number, number, number]>, start = 0) {
  return moves.map(([o, h, l, c], i) => mkCandle(o, h, l, c, start + i * 1000, "15M"));
}

describe("fair value gaps", () => {
  it("creates a bullish FVG when candle i-2 high < candle i low", () => {
    // candle1 high 100, candle3 low 102 -> gap [100, 102]
    const seq = candles([
      [99, 100, 98, 99],
      [99, 101, 99, 100],
      [100, 104, 102, 103],
    ]);
    const eng = new FvgEngine("BTCUSDT", "test", "15M");
    for (const c of seq) eng.update(c);
    const bullish = eng.getZones().filter((z) => z.direction === "BULLISH");
    expect(bullish.length).toBe(1);
    expect(bullish[0].bottom).toBe(100);
    expect(bullish[0].top).toBe(102);
  });

  it("creates a bearish FVG when candle i-2 low > candle i high", () => {
    const seq = candles([
      [103, 104, 102, 103],
      [103, 103, 100, 101],
      [101, 101, 98, 99],
    ]);
    const eng = new FvgEngine("BTCUSDT", "test", "15M");
    for (const c of seq) eng.update(c);
    const bearish = eng.getZones().filter((z) => z.direction === "BEARISH");
    expect(bearish.length).toBe(1);
    expect(bearish[0].bottom).toBe(101);
    expect(bearish[0].top).toBe(102);
  });

  it("mitigates a zone when price trades through it", () => {
    const seq = candles([
      [99, 100, 98, 99],
      [99, 101, 99, 100],
      [100, 104, 102, 103],
      [103, 103, 99, 100], // trades through [100,102]
    ]);
    const eng = new FvgEngine("BTCUSDT", "test", "15M");
    for (const c of seq) eng.update(c);
    const zone = eng.getZones()[0];
    expect(zone.status).toBe("MITIGATED");
  });

  it("creates no gap when candles overlap", () => {
    const seq = candles([
      [99, 101, 98, 100],
      [100, 101, 99, 100],
      [100, 101, 99, 100],
    ]);
    const eng = new FvgEngine("BTCUSDT", "test", "15M");
    for (const c of seq) eng.update(c);
    expect(eng.getZones().length).toBe(0);
  });
});
