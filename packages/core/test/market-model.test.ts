import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKET_MODEL,
  fundingCost,
  limitOrderFilled,
  meetsExchangeMinimums,
  simulateFill,
  slippagePctFor,
} from "../src/execution/market-model.js";

/**
 * Every cost here exists because omitting it makes paper trading optimistic.
 * These tests assert the direction of each cost as much as its size: a model
 * that ever helps the trader is worse than no model at all, because it would
 * be trusted.
 */
const config = DEFAULT_MARKET_MODEL;

describe("slippage", () => {
  it("grows with order size relative to depth", () => {
    const small = slippagePctFor(5_000, config);
    const large = slippagePctFor(50_000, config);
    expect(large).toBeGreaterThan(small);
  });

  it("grows sub-linearly, as market impact does", () => {
    const single = slippagePctFor(10_000, config);
    const quadruple = slippagePctFor(40_000, config);
    // Four times the size is twice the impact, not four times.
    expect(quadruple).toBeCloseTo(single * 2, 6);
  });

  it("widens with volatility", () => {
    const calm = slippagePctFor(10_000, config, 0);
    const volatile = slippagePctFor(10_000, config, 1);
    expect(volatile).toBeCloseTo(calm * 2, 6);
  });

  it("is zero for an order of no size", () => {
    expect(slippagePctFor(0, config)).toBe(0);
  });
});

describe("fills", () => {
  it("costs a buyer more than the intended price", () => {
    const fill = simulateFill(
      { side: "BUY", referencePrice: 100, quantity: 100, kind: "ENTRY" },
      config,
    );
    expect(fill.price).toBeGreaterThan(100);
    expect(fill.spreadCost).toBeGreaterThan(0);
    expect(fill.slippageCost).toBeGreaterThan(0);
  });

  it("pays a seller less than the intended price", () => {
    const fill = simulateFill(
      { side: "SELL", referencePrice: 100, quantity: 100, kind: "ENTRY" },
      config,
    );
    expect(fill.price).toBeLessThan(100);
  });

  it("fills a stop worse than an ordinary entry of the same size", () => {
    const entry = simulateFill({ side: "SELL", referencePrice: 100, quantity: 100, kind: "ENTRY" }, config);
    const stop = simulateFill({ side: "SELL", referencePrice: 100, quantity: 100, kind: "STOP" }, config);
    // A stop is a market order into a move already going against the position.
    expect(stop.price).toBeLessThan(entry.price);
    expect(stop.slippageCost).toBeGreaterThan(entry.slippageCost);
  });

  it("charges the maker fee on a resting target and the taker fee elsewhere", () => {
    const target = simulateFill({ side: "SELL", referencePrice: 100, quantity: 100, kind: "TARGET" }, config);
    const entry = simulateFill({ side: "SELL", referencePrice: 100, quantity: 100, kind: "ENTRY" }, config);
    expect(target.taker).toBe(false);
    expect(entry.taker).toBe(true);
    expect(target.fee).toBeLessThan(entry.fee);
  });

  it("gives a resting target no impact but still charges the spread", () => {
    const target = simulateFill({ side: "SELL", referencePrice: 100, quantity: 1_000, kind: "TARGET" }, config);
    expect(target.slippageCost).toBe(0);
    expect(target.spreadCost).toBeGreaterThan(0);
  });

  it("charges a larger order more in total than a smaller one", () => {
    const small = simulateFill({ side: "BUY", referencePrice: 100, quantity: 10, kind: "ENTRY" }, config);
    const large = simulateFill({ side: "BUY", referencePrice: 100, quantity: 1_000, kind: "ENTRY" }, config);
    expect(large.price).toBeGreaterThan(small.price);
    expect(large.fee).toBeGreaterThan(small.fee);
  });
});

describe("exchange minimums", () => {
  it("rejects a quantity below the exchange minimum", () => {
    const result = meetsExchangeMinimums(0.00001, 100, config);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/below the exchange minimum/);
  });

  it("rejects a notional below the exchange minimum", () => {
    const result = meetsExchangeMinimums(0.01, 100, { ...config, minQuantity: 0.001, minNotional: 10 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Notional/);
  });

  it("accepts an order that clears both", () => {
    expect(meetsExchangeMinimums(1, 100, config).ok).toBe(true);
  });
});

describe("funding", () => {
  it("charges nothing before a funding interval passes", () => {
    expect(fundingCost(10_000, 4 * 3_600_000, config)).toBe(0);
  });

  it("charges once per completed interval", () => {
    const one = fundingCost(10_000, 8 * 3_600_000, config);
    const three = fundingCost(10_000, 24 * 3_600_000, config);
    expect(one).toBeCloseTo(1, 6);
    expect(three).toBeCloseTo(3, 6);
  });

  it("is charged against the trader whichever way the position points", () => {
    // Predicting the sign of funding is not attempted; assuming it pays would
    // be exactly the optimism this model exists to remove.
    expect(fundingCost(-10_000, 8 * 3_600_000, config)).toBeGreaterThan(0);
  });
});

describe("limit fills", () => {
  it("does not fill an order merely touched by the bar", () => {
    // Touching a level is not being filled at it; the order joins a queue.
    expect(limitOrderFilled("BUY", 100, { high: 105, low: 100 }, config)).toBe(false);
  });

  it("fills when the bar trades decisively through the level", () => {
    expect(limitOrderFilled("BUY", 100, { high: 105, low: 98 }, config)).toBe(true);
  });

  it("applies the same rule to a sell", () => {
    expect(limitOrderFilled("SELL", 100, { high: 100, low: 95 }, config)).toBe(false);
    expect(limitOrderFilled("SELL", 100, { high: 102, low: 95 }, config)).toBe(true);
  });
});

describe("funding on a held position", () => {
  it("reduces the result of a position held across intervals", async () => {
    const { PositionManager } = await import("../src/execution/position-manager.js");
    const manager = new PositionManager({
      feePct: 0, slippagePct: 0, breakEvenOnTp1: false, partialPlan: [],
    });
    const opened = 0;
    manager.openPosition({
      symbol: "BTCUSDT", exchange: "t", direction: "LONG", setupId: "s",
      strategyVersion: "v1", entry: 100, positionSize: 100, notional: 10_000,
      stopLoss: 90, takeProfits: [110], openedAt: opened,
    });

    // Held for a day, then closed at target.
    manager.onBar("BTCUSDT", { high: 111, low: 100, close: 110 }, opened + 24 * 3_600_000);
    const [position] = manager.getClosedPositions();

    expect(position.fundingPaid).toBeGreaterThan(0);
    // Three eight-hour intervals at 0.01% of 10,000.
    expect(position.fundingPaid).toBeCloseTo(3, 6);
    expect(position.finalPnl).toBeCloseTo(position.realizedPnl - position.entryFee - 3, 6);
  });

  it("charges nothing on a position closed within an interval", async () => {
    const { PositionManager } = await import("../src/execution/position-manager.js");
    const manager = new PositionManager({
      feePct: 0, slippagePct: 0, breakEvenOnTp1: false, partialPlan: [],
    });
    manager.openPosition({
      symbol: "BTCUSDT", exchange: "t", direction: "LONG", setupId: "s",
      strategyVersion: "v1", entry: 100, positionSize: 100, notional: 10_000,
      stopLoss: 90, takeProfits: [110], openedAt: 0,
    });
    manager.onBar("BTCUSDT", { high: 111, low: 100, close: 110 }, 2 * 3_600_000);
    expect(manager.getClosedPositions()[0].fundingPaid).toBe(0);
  });
});

describe("the model never favours the trader", () => {
  it("costs something on every fill, in both directions", () => {
    for (const side of ["BUY", "SELL"] as const) {
      for (const kind of ["ENTRY", "STOP", "TARGET"] as const) {
        const fill = simulateFill({ side, referencePrice: 100, quantity: 50, kind }, config);
        const worse = side === "BUY" ? fill.price >= 100 : fill.price <= 100;
        expect(worse).toBe(true);
        expect(fill.fee).toBeGreaterThan(0);
      }
    }
  });
});
