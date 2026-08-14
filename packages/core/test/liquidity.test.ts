import { describe, expect, it } from "vitest";
import { LiquidityEngine } from "../src/engines/liquidity.js";
import { bullishStructure, bearishStructure, trendUnits } from "./fixtures.js";

describe("liquidity engine", () => {
  it("creates BSL above bullish swing highs and SSL below swing lows", () => {
    const eng = new LiquidityEngine("BTCUSDT", "test", "4H", { strength: 2, toleranceAtr: 0.15 });
    for (const c of bullishStructure("4H")) eng.update(c);
    const zones = eng.getZones();
    expect(zones.some((z) => z.type === "BSL")).toBe(true);
    expect(zones.some((z) => z.type === "SSL")).toBe(true);
  });

  it("sweeps a BSL when a candle trades through it", () => {
    const candles = bullishStructure("4H");
    const eng = new LiquidityEngine("BTCUSDT", "test", "4H", { strength: 2, toleranceAtr: 0.15 });
    for (const c of candles) eng.update(c);
    const lastTime = candles[candles.length - 1].timestamp;
    const dur = 14400000;
    const swept = eng.update({
      symbol: "BTCUSDT",
      exchange: "test",
      timeframe: "4H",
      timestamp: lastTime + dur,
      open: 100,
      high: 120,
      low: 99,
      close: 93, // closes back below the swept high -> rejection
      volume: 100,
    });
    expect(swept.sweeps.length).toBeGreaterThan(0);
    const bslSweep = swept.sweeps.find((s) => s.direction === "SHORT");
    expect(bslSweep).toBeDefined();
    expect(bslSweep?.rejected).toBe(true);
  });

  it("sweeps an SSL when a candle trades through it", () => {
    // Feed up to C_6 (27 of 28 candles): the last confirmed SSL (D_5 @ 97.0) is
    // still active because the breaking D_6 candle has not closed yet.
    const candles = trendUnits(7, 100, -0.5, "4H").slice(0, 27);
    const eng = new LiquidityEngine("BTCUSDT", "test", "4H", { strength: 2, toleranceAtr: 0.15 });
    for (const c of candles) eng.update(c);
    const lastTime = candles[candles.length - 1].timestamp;
    const dur = 14400000;
    const swept = eng.update({
      symbol: "BTCUSDT",
      exchange: "test",
      timeframe: "4H",
      timestamp: lastTime + dur,
      open: 100,
      high: 101,
      low: 80,
      close: 99,
      volume: 100,
    });
    const sslSweep = swept.sweeps.find((s) => s.direction === "LONG");
    expect(sslSweep).toBeDefined();
    expect(sslSweep?.rejected).toBe(true);
  });

  it("exposes targeted helpers for long and short liquidity", () => {
    const eng = new LiquidityEngine("BTCUSDT", "test", "4H", { strength: 2, toleranceAtr: 0.15 });
    for (const c of bullishStructure("4H")) eng.update(c);
    const above = eng.above(90);
    const below = eng.below(200);
    expect(above.length).toBeGreaterThan(0);
    expect(above.every((z) => z.type === "BSL" && z.level > 90)).toBe(true);
    expect(below.length).toBeGreaterThan(0);
    expect(below.every((z) => z.type === "SSL" && z.level < 200)).toBe(true);
  });

  it("is deterministic for identical input", () => {
    const a = new LiquidityEngine("BTCUSDT", "test", "4H", { strength: 2 });
    const b = new LiquidityEngine("BTCUSDT", "test", "4H", { strength: 2 });
    for (const c of bullishStructure("4H")) a.update(c);
    for (const c of bullishStructure("4H")) b.update(c);
    expect(JSON.stringify(a.getZones())).toBe(JSON.stringify(b.getZones()));
  });
});
