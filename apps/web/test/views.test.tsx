import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsView, TradeDetailView } from "../src/components/Analytics";
import { RejectedSetups, SetupCard } from "../src/components/SetupViews";
import type { Analytics, Setup, TradeDetail } from "../src/api";

/**
 * These render the delivered views to static markup. They cannot replace using
 * the app, but they do prove each view renders real engine payloads — and the
 * empty and degraded shapes — without throwing.
 */

const emptyStats: Analytics["stats"] = {
  totalTrades: 0, wins: 0, losses: 0, winRate: 0, netPnl: 0, grossProfit: 0, grossLoss: 0,
  profitFactor: 0, expectancy: 0, avgTrade: 0, avgWin: 0, avgLoss: 0, largestWin: 0,
  largestLoss: 0, maxConsecutiveWins: 0, maxConsecutiveLosses: 0, avgRr: 0, avgDurationMs: 0,
  maxDrawdown: 0, maxDrawdownPct: 0, finalEquity: 10_000, totalReturnPct: 0, sharpe: 0,
  byMonth: {}, bySetupType: {}, byAsset: {},
};

function analytics(overrides: Partial<Analytics> = {}): Analytics {
  return {
    stats: emptyStats,
    funnel: { seen: 0, valid: 0, executed: 0, rejected: 0, executionRate: 0 },
    rejectionReasons: [],
    openPositions: 0,
    closedPositions: 0,
    startingEquity: 10_000,
    equityCurve: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

function setup(overrides: Partial<Setup> = {}): Setup {
  return {
    id: "s-1",
    symbol: "BTCUSDT",
    direction: "LONG",
    timeframe: "15M",
    entryModel: "SWEEP",
    entry: 102_430,
    stopLoss: 101_870,
    stopLossReason: "Below the structural swing low that invalidates the setup.",
    takeProfits: [104_110, 105_900],
    takeProfitReasons: ["Internal buy-side liquidity", "External swing high"],
    rr: [3, 6.2],
    score: 91,
    status: "VALID",
    hardRules: [{ name: "HTF bias", status: "PASS", detail: "Higher timeframe is bullish." }],
    factors: [{ name: "Sweep", status: "PASS", detail: "Sell-side liquidity was swept." }],
    qualityFactors: [{ name: "Momentum", status: "NEUTRAL", detail: "Momentum is average." }],
    reasons: ["All mandatory conditions passed."],
    rejectionReasons: [],
    createdAt: Date.parse("2024-05-01T10:00:00Z"),
    ...overrides,
  };
}

describe("AnalyticsView", () => {
  it("explains the absence of metrics instead of showing empty numbers", () => {
    const html = renderToStaticMarkup(<AnalyticsView data={analytics()} />);
    expect(html).toContain("No closed trades yet");
    expect(html).toContain("does not");
  });

  it("renders headline performance once trades have settled", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView
        data={analytics({
          stats: {
            ...emptyStats,
            totalTrades: 4, wins: 3, losses: 1, winRate: 75, netPnl: 420,
            grossProfit: 520, grossLoss: 100, profitFactor: 5.2, expectancy: 105,
            avgRr: 2.4, maxDrawdownPct: 3.1, totalReturnPct: 4.2,
            bySetupType: { SWEEP: { trades: 3, pnl: 400, winRate: 100 } },
            byAsset: { BTCUSDT: { trades: 4, pnl: 420, winRate: 75 } },
          },
          funnel: { seen: 10, valid: 5, executed: 4, rejected: 5, executionRate: 40 },
          closedPositions: 4,
          equityCurve: [
            { timestamp: 1, equity: 10_000 },
            { timestamp: 2, equity: 10_420 },
          ],
        })}
      />,
    );
    expect(html).toContain("75%");
    expect(html).toContain("5.2");
    expect(html).toContain("SWEEP");
    expect(html).toContain("BTCUSDT");
  });

  it("shows an infinite profit factor as a symbol rather than as NaN or Infinity text", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView data={analytics({ stats: { ...emptyStats, totalTrades: 1, wins: 1, profitFactor: Infinity, netPnl: 50 } })} />,
    );
    expect(html).toContain("∞");
    expect(html).not.toContain("NaN");
  });

  it("ranks the reasons the engine declined setups", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView
        data={analytics({
          funnel: { seen: 6, valid: 1, executed: 0, rejected: 5, executionRate: 0 },
          rejectionReasons: [
            { reason: "RR below the configured minimum", count: 3 },
            { reason: "Daily trade limit reached", count: 2 },
          ],
        })}
      />,
    );
    expect(html).toContain("RR below the configured minimum");
    expect(html).toContain("Daily trade limit reached");
  });
});

describe("TradeDetailView", () => {
  const position: NonNullable<TradeDetail["position"]> = {
    id: "POS-1",
    symbol: "BTCUSDT",
    direction: "LONG",
    setupId: "s-1",
    entry: 102_430,
    currentPrice: 104_110,
    positionSize: 0.018,
    notional: 1_843.74,
    stopLoss: 101_870,
    sl: 102_430,
    takeProfits: [104_110, 105_900],
    unrealizedPnl: 0,
    status: "CLOSED",
    openedAt: Date.parse("2024-05-01T10:00:00Z"),
    closedAt: Date.parse("2024-05-01T14:00:00Z"),
    closeReason: "TAKE_PROFIT",
    finalPnl: 30.24,
    realizedPnl: 30.24,
    entryFee: 0.74,
    quantityRemaining: 0,
    closedQuantity: 0.018,
    entryModel: "SWEEP",
    plannedRr: [3, 6.2],
    mae: 120,
    mfe: 1_680,
    strategyVersion: "smc-1.0.0",
    events: [
      { type: "OPENED", timestamp: Date.parse("2024-05-01T10:00:00Z"), positionId: "POS-1", detail: "Position opened." },
      { type: "TP1_REACHED", timestamp: Date.parse("2024-05-01T12:00:00Z"), positionId: "POS-1", detail: "TP1 reached, 50% closed." },
      { type: "BREAK_EVEN", timestamp: Date.parse("2024-05-01T12:00:01Z"), positionId: "POS-1", detail: "Stop moved to entry." },
      { type: "CLOSED", timestamp: Date.parse("2024-05-01T14:00:00Z"), positionId: "POS-1", detail: "Closed at TP2.", realizedPnl: 30.24 },
    ],
  };

  it("renders the management timeline and the originating setup's reasoning", () => {
    const html = renderToStaticMarkup(
      <TradeDetailView detail={{ found: true, position, setup: setup({ status: "EXECUTED" }), events: position.events, journal: [] }} onBack={() => {}} />,
    );
    expect(html).toContain("TP1 REACHED");
    expect(html).toContain("BREAK EVEN");
    expect(html).toContain("Below the structural swing low");
    expect(html).toContain("HTF bias");
    expect(html).toContain("smc-1.0.0");
  });

  it("still renders when the originating setup has aged out of the window", () => {
    const html = renderToStaticMarkup(
      <TradeDetailView detail={{ found: true, position, setup: null, events: position.events }} onBack={() => {}} />,
    );
    expect(html).toContain("aged out");
    expect(html).not.toContain("undefined");
  });

  it("reports a missing trade rather than rendering a blank page", () => {
    const html = renderToStaticMarkup(
      <TradeDetailView detail={{ found: false, reason: "No position with that identifier." }} onBack={() => {}} />,
    );
    expect(html).toContain("No position with that identifier.");
  });
});

describe("Setup views", () => {
  it("shows a setup's levels and score on its card", () => {
    const html = renderToStaticMarkup(<SetupCard setup={setup()} />);
    expect(html).toContain("91");
    expect(html).toContain("SWEEP");
    expect(html).toContain("1:3");
  });

  it("marks a counter-trend setup explicitly", () => {
    const html = renderToStaticMarkup(<SetupCard setup={setup({ counterTrend: true })} />);
    expect(html).toContain("COUNTER-TREND");
  });

  it("lists each declined setup with its reason", () => {
    const html = renderToStaticMarkup(
      <RejectedSetups
        setups={[
          setup({ id: "r-1", status: "REJECTED", rejectionReasons: ["RR = 1:2.1. Minimum required = 1:3."] }),
          setup({ id: "v-1", status: "VALID" }),
        ]}
      />,
    );
    expect(html).toContain("RR = 1:2.1");
    // A valid setup must not appear in the rejected view.
    expect(html.match(/BTCUSDT/g)?.length).toBe(1);
  });

  it("explains the empty state when nothing has been rejected", () => {
    const html = renderToStaticMarkup(<RejectedSetups setups={[setup({ status: "VALID" })]} />);
    expect(html).toContain("No rejected setups yet");
  });
});
