import { describe, expect, it } from "vitest";
import type { Candle } from "../src/types/candles.js";
import { SupplyDemandEngine } from "../src/engines/supplydemand.js";

function candle(open: number, high: number, low: number, close: number, timestamp: number): Candle {
  return { symbol: "BTCUSDT", exchange: "test", timeframe: "15M", timestamp, open, high, low, close, volume: 100 };
}

/** Small range candles create a compact base; the big body breaks away. */
function baseAndBreak(breakOpen: number, breakClose: number, start: number): Candle[] {
  return [
    candle(50, 50.4, 49.6, 50.3, start),
    candle(50.3, 50.6, 49.9, 50.5, start + 1),
    candle(50.5, 50.7, 50.0, 50.2, start + 2),
    candle(50.2, 50.6, 50.1, 50.4, start + 3),
    candle(breakOpen, breakClose + 4, Math.min(breakOpen, breakClose) - 1, breakClose, start + 4),
  ];
}

describe("SupplyDemandEngine", () => {
  it("creates a DEMAND zone under a bullish displacement", () => {
    const engine = new SupplyDemandEngine("BTCUSDT", "test", "15M");
    const candles = baseAndBreak(50.5, 55.5, 1000);
    let created: ReturnType<SupplyDemandEngine["update"]>["created"] = [];
    for (const c of candles) created = engine.update(c).created;
    const zones = engine.getZones();
    expect(zones.length).toBeGreaterThan(0);
    const demand = engine.fresh("DEMAND");
    expect(demand.length).toBeGreaterThan(0);
    expect(demand[0].kind).toBe("DEMAND");
    expect(demand[0].top).toBeGreaterThan(demand[0].bottom);
    expect(created.length).toBeGreaterThan(0);
  });

  it("marks a zone MITIGATED when price trades through it", () => {
    const engine = new SupplyDemandEngine("BTCUSDT", "test", "15M");
    for (const c of baseAndBreak(50.5, 55.5, 1000)) engine.update(c);
    const demand = engine.fresh("DEMAND");
    expect(demand.length).toBe(1);

    // Price comes back down through the zone's full range.
    engine.update(candle(52, 53, 48, 49, 2000));
    const mitigated = engine.getZones().filter((z) => z.status === "MITIGATED");
    expect(mitigated.length).toBe(1);
    expect(mitigated[0].mitigatedAt).toBe(2000);
  });

  it("increments touch count and reduces rank when price overlaps the zone", () => {
    const engine = new SupplyDemandEngine("BTCUSDT", "test", "15M");
    for (const c of baseAndBreak(50.5, 55.5, 1000)) engine.update(c);
    const before = engine.fresh("DEMAND")[0].rank;
    engine.update(candle(52, 54, 49.5, 53, 2000));
    const after = engine.fresh("DEMAND")[0];
    expect(after.touchCount).toBe(1);
    expect(after.rank).toBeLessThan(before);
  });

  it("does not create a zone without enough base candles", () => {
    const engine = new SupplyDemandEngine("BTCUSDT", "test", "15M");
    engine.update(candle(50, 50.5, 49.5, 50.4, 1000));
    engine.update(candle(50.4, 55.5, 50.3, 55.0, 2000));
    expect(engine.getZones().length).toBe(0);
  });

  it("creates a SUPPLY zone under a bearish displacement", () => {
    const engine = new SupplyDemandEngine("BTCUSDT", "test", "15M");
    for (const c of baseAndBreak(49.5, 44.5, 1000)) engine.update(c);
    const supply = engine.fresh("SUPPLY");
    expect(supply.length).toBe(1);
  });
});
