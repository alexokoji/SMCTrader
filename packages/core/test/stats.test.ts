import { describe, expect, it } from "vitest";
import { computeStats } from "../src/backtest/stats.js";
import type { BacktestTrade } from "../src/backtest/engine.js";

function trade(overrides: Partial<BacktestTrade>): BacktestTrade {
  return {
    setupId: "s-1",
    symbol: "BTCUSDT",
    direction: "LONG",
    entry: 100,
    exit: 110,
    stopLoss: 95,
    takeProfits: [110],
    quantity: 1,
    pnl: 10,
    rr: 2,
    score: 80,
    entryModel: "CONFIRMATION",
    openedAt: Date.parse("2024-03-01T00:00:00Z"),
    closedAt: Date.parse("2024-03-01T04:00:00Z"),
    durationMs: 4 * 3_600_000,
    mae: 2,
    mfe: 12,
    closeReason: "TAKE_PROFIT",
    strategyVersion: "test",
    ...overrides,
  };
}

describe("computeStats", () => {
  it("reports a finite profit factor when there are both wins and losses", () => {
    const trades = [
      trade({ pnl: 300 }),
      trade({ pnl: 200 }),
      trade({ pnl: -100 }),
      trade({ pnl: -150 }),
    ];
    const stats = computeStats(trades, [{ timestamp: 1, equity: 10_250 }], 10_000);

    expect(stats.grossProfit).toBe(500);
    expect(stats.grossLoss).toBe(250);
    // 500 / 250 — not Infinity, which is what a negative gross-loss comparison produced.
    expect(stats.profitFactor).toBeCloseTo(2, 10);
    expect(Number.isFinite(stats.profitFactor)).toBe(true);
  });

  it("reports an infinite profit factor only when nothing was lost", () => {
    const stats = computeStats([trade({ pnl: 120 })], [{ timestamp: 1, equity: 10_120 }], 10_000);
    expect(stats.grossLoss).toBe(0);
    expect(stats.profitFactor).toBe(Infinity);
  });

  it("reports a zero profit factor when there was no profit", () => {
    const stats = computeStats([trade({ pnl: -80 })], [{ timestamp: 1, equity: 9_920 }], 10_000);
    expect(stats.profitFactor).toBe(0);
  });

  it("states gross loss and average loss as positive magnitudes", () => {
    const stats = computeStats(
      [trade({ pnl: -40 }), trade({ pnl: -60 })],
      [{ timestamp: 1, equity: 9_900 }],
      10_000,
    );
    expect(stats.grossLoss).toBe(100);
    expect(stats.avgLoss).toBe(50);
  });

  it("counts consecutive wins and losses over the trade sequence", () => {
    const stats = computeStats(
      [trade({ pnl: 10 }), trade({ pnl: 10 }), trade({ pnl: 10 }), trade({ pnl: -5 }), trade({ pnl: -5 })],
      [{ timestamp: 1, equity: 10_020 }],
      10_000,
    );
    expect(stats.maxConsecutiveWins).toBe(3);
    expect(stats.maxConsecutiveLosses).toBe(2);
  });

  it("breaks performance down by asset and entry model", () => {
    const stats = computeStats(
      [
        trade({ symbol: "BTCUSDT", entryModel: "SWEEP", pnl: 100 }),
        trade({ symbol: "ETHUSDT", entryModel: "SWEEP", pnl: -50 }),
        trade({ symbol: "ETHUSDT", entryModel: "CONFIRMATION", pnl: 25 }),
      ],
      [{ timestamp: 1, equity: 10_075 }],
      10_000,
    );
    expect(stats.byAsset.ETHUSDT.trades).toBe(2);
    expect(stats.byAsset.ETHUSDT.pnl).toBe(-25);
    expect(stats.byAsset.ETHUSDT.winRate).toBeCloseTo(50, 10);
    expect(stats.bySetupType.SWEEP.trades).toBe(2);
    expect(stats.bySetupType.CONFIRMATION.winRate).toBe(100);
  });
});
