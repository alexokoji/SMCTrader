import { describe, expect, it } from "vitest";
import { OrderBlockEngine } from "../src/engines/orderblock.js";
import type { Candle } from "../src/types/candles.js";

const START = Date.parse("2024-04-01T00:00:00Z");
const HOUR = 3_600_000;

function bar(i: number, open: number, close: number, pad = 5): Candle {
  return {
    symbol: "BTCUSDT",
    exchange: "test",
    timeframe: "1H",
    timestamp: START + i * HOUR,
    open,
    close,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad,
    volume: 1,
  };
}

/** Quiet baseline so ATR settles, then the caller adds the pattern. */
function baseline(count = 20): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (i % 2 === 0 ? 1 : -1);
    out.push(bar(i, open, close));
    price = close;
  }
  return out;
}

function feed(engine: OrderBlockEngine, candles: Candle[]) {
  return candles.map((c) => engine.update(c));
}

describe("order block impulse origin", () => {
  it("finds the origin when the impulse spans several same-colour candles", () => {
    const engine = new OrderBlockEngine("BTCUSDT", "test", "1H");
    const candles = baseline();
    const n = candles.length;
    // The order block: the last down candle before the move up.
    candles.push(bar(n, 100, 90));
    // Impulse leg: three up candles, the last one a large displacement.
    candles.push(bar(n + 1, 90, 96));
    candles.push(bar(n + 2, 96, 102));
    candles.push(bar(n + 3, 102, 160));

    feed(engine, candles);
    const blocks = engine.getBlocks();

    expect(blocks.length).toBeGreaterThan(0);
    const bullish = blocks.find((b) => b.direction === "BULLISH");
    expect(bullish).toBeDefined();
    // The zone is the down candle, not whichever bar happened to sit at n-2.
    expect(bullish!.bottom).toBeCloseTo(85, 6);
    expect(bullish!.top).toBeCloseTo(105, 6);
  });

  it("does not mitigate a block with the very candle that created it", () => {
    const engine = new OrderBlockEngine("BTCUSDT", "test", "1H");
    const candles = baseline();
    const n = candles.length;
    candles.push(bar(n, 100, 90));
    candles.push(bar(n + 1, 90, 175));

    feed(engine, candles);
    const bullish = engine.getBlocks().find((b) => b.direction === "BULLISH");

    expect(bullish).toBeDefined();
    // The displacement candle trades straight through its own origin zone;
    // treating that as mitigation left every block dead on arrival.
    expect(bullish!.status).toBe("FRESH");
    expect(engine.fresh("BULLISH")).toHaveLength(1);
  });

  it("still mitigates once a later candle closes back through the zone", () => {
    const engine = new OrderBlockEngine("BTCUSDT", "test", "1H");
    const candles = baseline();
    const n = candles.length;
    candles.push(bar(n, 100, 90));
    candles.push(bar(n + 1, 90, 175));
    // Price returns and closes below the block.
    candles.push(bar(n + 2, 170, 80));

    feed(engine, candles);
    const bullish = engine.getBlocks().find((b) => b.direction === "BULLISH");
    expect(bullish!.status).toBe("MITIGATED");
    expect(engine.fresh("BULLISH")).toHaveLength(0);
  });

  it("builds a bearish block from the last up candle before a drop", () => {
    const engine = new OrderBlockEngine("BTCUSDT", "test", "1H");
    const candles = baseline();
    const n = candles.length;
    candles.push(bar(n, 90, 100));
    candles.push(bar(n + 1, 100, 94));
    candles.push(bar(n + 2, 94, 30));

    feed(engine, candles);
    const bearish = engine.getBlocks().find((b) => b.direction === "BEARISH");
    expect(bearish).toBeDefined();
    expect(bearish!.top).toBeCloseTo(105, 6);
  });

  it("gives up rather than reaching past the configured impulse lookback", () => {
    const engine = new OrderBlockEngine("BTCUSDT", "test", "1H", { impulseLookback: 2 });
    const candles = baseline();
    const n = candles.length;
    candles.push(bar(n, 100, 90));
    // Four up candles before the displacement puts the origin out of range.
    candles.push(bar(n + 1, 90, 93));
    candles.push(bar(n + 2, 93, 96));
    candles.push(bar(n + 3, 96, 99));
    candles.push(bar(n + 4, 99, 160));

    feed(engine, candles);
    expect(engine.getBlocks().filter((b) => b.direction === "BULLISH")).toHaveLength(0);
  });
});
