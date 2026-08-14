import { describe, expect, it } from "vitest";
import { OrderBlockEngine } from "../src/engines/orderblock.js";
import { mkCandle } from "./fixtures.js";

function seq(moves: Array<[number, number, number, number]>) {
  return moves.map(([o, h, l, c], i) => mkCandle(o, h, l, c, i * 1000, "15M"));
}

/** steady oscillating candles: ranges are uniform so ATR warms up without creating spurious displacement */
function seed(): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  let p = 100;
  for (let i = 0; i < 20; i++) {
    const c = p + (i % 2 === 0 ? 1 : -1);
    out.push([p, c + 0.9, c - 0.9, c]);
    p = c;
  }
  return out;
}

describe("order blocks", () => {
  it("creates a bullish order block from the last down candle before displacement", () => {
    const candles = seq([
      ...seed(),
      [100, 100.4, 99.0, 99.1], // last down candle -> order block
      [100.6, 105.0, 100.3, 104.8], // large bullish displacement that gaps away from the block
    ]);
    const eng = new OrderBlockEngine("BTCUSDT", "test", "15M", { displacementAtrMultiple: 1.5 });
    for (const c of candles) eng.update(c);
    const blocks = eng.fresh("BULLISH");
    expect(blocks.length).toBe(1);
    expect(blocks[0].bottom).toBe(99.0);
    expect(blocks[0].top).toBe(100.4);
  });

  it("creates a bearish order block from the last up candle before displacement", () => {
    const candles = seq([
      ...seed(),
      [100, 100.8, 100.1, 100.7], // last up candle -> order block
      [100.5, 100.6, 95.6, 95.8], // large bearish displacement that gaps away from the block
    ]);
    const eng = new OrderBlockEngine("BTCUSDT", "test", "15M", { displacementAtrMultiple: 1.5 });
    for (const c of candles) eng.update(c);
    const blocks = eng.fresh("BEARISH");
    expect(blocks.length).toBe(1);
    expect(blocks[0].bottom).toBe(100.1);
    expect(blocks[0].top).toBe(100.8);
  });

  it("requires a displacement-sized move", () => {
    const candles = seq([
      ...seed(),
      [100, 100.4, 99.8, 100.2],
      [100.2, 100.5, 99.9, 100.4], // tiny candle, no displacement
    ]);
    const eng = new OrderBlockEngine("BTCUSDT", "test", "15M", { displacementAtrMultiple: 1.5 });
    for (const c of candles) eng.update(c);
    expect(eng.getBlocks().length).toBe(0);
  });

  it("tracks touches without mitigating a block that is merely approached", () => {
    const candles = seq([
      ...seed(),
      [100, 100.4, 99.0, 99.1],
      [100.6, 105.0, 100.3, 104.8], // displacement gaps away, block stays FRESH
      [104.8, 104.9, 100.2, 100.5], // pulls back into the block top (100.4)
    ]);
    const eng = new OrderBlockEngine("BTCUSDT", "test", "15M", { displacementAtrMultiple: 1.5 });
    for (const c of candles) eng.update(c);
    const block = eng.fresh("BULLISH")[0];
    expect(block).toBeDefined();
    expect(block.touchCount).toBeGreaterThan(0);
  });
});
