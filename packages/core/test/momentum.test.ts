import { describe, expect, it } from "vitest";
import type { Candle } from "../src/types/candles.js";
import { MomentumEngine } from "../src/engines/momentum.js";

function candle(open: number, high: number, low: number, close: number, timestamp: number): Candle {
  return { symbol: "BTCUSDT", exchange: "test", timeframe: "15M", timestamp, open, high, low, close, volume: 100 };
}

describe("MomentumEngine", () => {
  it("returns NEUTRAL with insufficient data", () => {
    const engine = new MomentumEngine("BTCUSDT", "test", "15M");
    engine.update(candle(100, 101, 99, 100, 1000));
    const state = engine.evaluate();
    expect(state.direction).toBe("NEUTRAL");
    expect(state.label).toBe("Insufficient data");
    expect(state.impulse).toBe(false);
  });

  it("detects a bullish impulse from strong displacement and consecutive up candles", () => {
    const engine = new MomentumEngine("BTCUSDT", "test", "15M");
    const candles: Candle[] = [
      candle(100, 100.5, 99.5, 100.4, 1000),
      candle(100.4, 100.9, 99.9, 100.8, 2000),
      candle(100.8, 101.3, 100.3, 101.2, 3000),
      candle(101.2, 101.7, 100.7, 101.6, 4000),
      candle(101.6, 102.1, 101.1, 102.0, 5000),
      candle(102.0, 102.5, 101.5, 102.4, 6000),
      candle(102.4, 102.9, 101.9, 102.8, 7000),
    ];
    for (const c of candles) engine.update(c);
    const state = engine.evaluate();
    expect(state.direction).toBe("UP");
    expect(state.impulse).toBe(true);
    expect(state.consecutiveDirection).toBeGreaterThanOrEqual(3);
    expect(state.displacement).toBeGreaterThan(0);
    expect(state.score).toBeGreaterThan(0);
  });

  it("rejects out-of-order updates without changing state", () => {
    const engine = new MomentumEngine("BTCUSDT", "test", "15M");
    const a = candle(100, 101, 99, 100, 1000);
    engine.update(a);
    const before = engine.evaluate();
    const after = engine.update(candle(99, 99.5, 98.5, 99, 900));
    expect(after).toEqual(before);
  });

  it("labels a strong single displacement without a run as displacement, not impulse", () => {
    const engine = new MomentumEngine("BTCUSDT", "test", "15M");
    const candles: Candle[] = [
      candle(100, 100.5, 99.5, 100.3, 1000),
      candle(100.3, 100.8, 99.8, 100.7, 2000),
      candle(100.7, 101.2, 100.2, 101.1, 3000),
      candle(101.1, 105.0, 101.0, 104.8, 4000),
    ];
    for (const c of candles) engine.update(c);
    const state = engine.evaluate();
    expect(state.impulse).toBe(false);
    expect(state.label).toContain("displacement");
  });
});
