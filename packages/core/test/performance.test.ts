import { describe, expect, it } from "vitest";
import {
  computePerformance,
  positionsToTrades,
  summariseRejections,
} from "../src/analytics/performance.js";
import type { ManagedPosition } from "../src/execution/position-manager.js";
import { makeSetup } from "./helpers.js";

const OPENED = Date.parse("2024-05-01T00:00:00Z");

function position(overrides: Partial<ManagedPosition> = {}): ManagedPosition {
  return {
    id: "POS-1",
    symbol: "BTCUSDT",
    exchange: "test",
    direction: "LONG",
    setupId: "s-1",
    strategyVersion: "test",
    entryModel: "SWEEP",
    plannedRr: [3],
    entry: 100,
    positionSize: 2,
    notional: 200,
    stopLoss: 95,
    takeProfits: [115],
    partialPlan: [],
    currentPrice: 115,
    unrealizedPnl: 0,
    openedAt: OPENED,
    closedAt: OPENED + 3_600_000,
    sl: 95,
    quantityRemaining: 0,
    closedQuantity: 2,
    realizedPnl: 30,
    entryFee: 0,
    events: [],
    status: "CLOSED",
    closeReason: "TAKE_PROFIT",
    finalPnl: 30,
    mae: 1,
    mfe: 16,
    ...overrides,
  };
}

describe("positionsToTrades", () => {
  it("ignores open positions so metrics describe settled outcomes only", () => {
    const trades = positionsToTrades([
      position(),
      position({ id: "POS-2", status: "OPEN", finalPnl: undefined }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].setupId).toBe("s-1");
  });

  it("measures realised RR against the entry-to-stop distance", () => {
    // Risk 5 per unit over 2 units = 10 risked; +30 realised = 3R.
    const [trade] = positionsToTrades([position({ finalPnl: 30 })]);
    expect(trade.rr).toBeCloseTo(3, 10);
  });

  it("reports zero RR rather than dividing by zero when the stop sat at entry", () => {
    const [trade] = positionsToTrades([position({ stopLoss: 100, finalPnl: 12 })]);
    expect(trade.rr).toBe(0);
  });

  it("carries the entry model through so performance can be attributed by model", () => {
    const [trade] = positionsToTrades([position({ entryModel: "CONFIRMATION" })]);
    expect(trade.entryModel).toBe("CONFIRMATION");
  });

  it("falls back to a close event when no closedAt was recorded", () => {
    const [trade] = positionsToTrades([
      position({
        closedAt: undefined,
        events: [
          { type: "OPENED", timestamp: OPENED, positionId: "POS-1", detail: "" },
          { type: "CLOSED", timestamp: OPENED + 7_200_000, positionId: "POS-1", detail: "" },
        ],
      }),
    ]);
    expect(trade.durationMs).toBe(7_200_000);
  });
});

describe("summariseRejections", () => {
  it("ranks the reasons blocking trades by frequency", () => {
    const setups = [
      { ...makeSetup(), status: "REJECTED" as const, rejectionReasons: ["RR below minimum", "Risk limit reached"] },
      { ...makeSetup(), status: "REJECTED" as const, rejectionReasons: ["RR below minimum"] },
      { ...makeSetup(), status: "VALID" as const, rejectionReasons: ["ignored, not rejected"] },
    ];
    const summary = summariseRejections(setups);
    expect(summary[0]).toEqual({ reason: "RR below minimum", count: 2 });
    expect(summary.map((r) => r.reason)).not.toContain("ignored, not rejected");
  });
});

describe("computePerformance", () => {
  it("reports the setup funnel and execution rate", () => {
    const setups = [
      { ...makeSetup(), status: "EXECUTED" as const },
      { ...makeSetup(), status: "VALID" as const },
      { ...makeSetup(), status: "REJECTED" as const, rejectionReasons: ["Daily trade limit reached"] },
      { ...makeSetup(), status: "STALE" as const, rejectionReasons: ["Setup expired"] },
    ];
    const result = computePerformance({
      positions: [position()],
      setups,
      equityCurve: [{ timestamp: OPENED, equity: 10_030 }],
      startingEquity: 10_000,
    });

    expect(result.funnel).toEqual({
      seen: 4,
      valid: 1,
      executed: 1,
      rejected: 2,
      executionRate: 25,
    });
    expect(result.closedPositions).toBe(1);
    expect(result.stats.netPnl).toBe(30);
    expect(result.rejectionReasons).toHaveLength(2);
  });

  it("returns zeroed metrics rather than failing when nothing has traded", () => {
    const result = computePerformance({
      positions: [],
      setups: [],
      equityCurve: [],
      startingEquity: 10_000,
    });
    expect(result.stats.totalTrades).toBe(0);
    expect(result.funnel.executionRate).toBe(0);
    expect(result.stats.netPnl).toBe(0);
  });
});
