import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentsView,
  ConditionsView,
  NewsView,
  PortfolioView,
  TradesView,
} from "../src/components/AgentViews";
import type { AgentSnapshot, AgentTrade, NewsResult, Portfolio } from "../src/agents-api";

/**
 * These render the delivered views to static markup. They cannot replace using
 * the app, but they do prove each view renders real payloads — and the empty
 * and degraded shapes — without throwing.
 */

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    config: {
      id: "a-1",
      name: "Trend follower",
      mode: "PAPER",
      allocatedCapital: 5_000,
      symbols: ["BTCUSDT"],
      timeframes: { htf: "4H", mtf: "1H", ltf: "15M" },
      entryModels: ["CONFIRMATION", "SWEEP"],
      baseline: { riskPerTrade: 1, minRr: 3, minScore: 60 },
      working: { riskPerTrade: 1, minRr: 3, minScore: 60 },
      requiredRegimes: [],
      maxOpenPositions: 5,
      maxDailyLossPct: 3,
      maxDrawdownPct: 10,
      status: "ACTIVE",
      createdAt: 1,
      updatedAt: 1,
    },
    performance: {
      closedTrades: 12, wins: 8, losses: 4, winRate: 66.7, netPnl: 320,
      profitFactor: 2.1, consecutiveLosses: 0, drawdownPct: 1.5,
      equity: 5_320, openPositions: 1,
    },
    supervisor: {
      state: "HEALTHY",
      headline: "Performing as analysed: 66.7% win rate over 12 trades.",
      observations: ["Results are consistent with the analysis."],
      adjustments: [],
    },
    adjustmentHistory: [],
    ...overrides,
  };
}

const noop = () => {};

describe("AgentsView", () => {
  it("explains the empty state rather than showing a blank panel", () => {
    const html = renderToStaticMarkup(
      <AgentsView agents={[]} capital={{ total: 10_000, committed: 0 }} onUpdate={noop} onRemove={noop} />,
    );
    expect(html).toContain("No agents yet");
    expect(html).toMatch(/cannot spend/);
  });

  it("shows an agent's capital, results and supervisor verdict", () => {
    const html = renderToStaticMarkup(
      <AgentsView agents={[snapshot()]} capital={{ total: 10_000, committed: 5_000 }} onUpdate={noop} onRemove={noop} />,
    );
    expect(html).toContain("Trend follower");
    expect(html).toContain("$5,000");
    expect(html).toContain("66.7%");
    expect(html).toContain("Performing as analysed");
  });

  it("reports uncommitted capital so allocation is obvious", () => {
    const html = renderToStaticMarkup(
      <AgentsView agents={[snapshot()]} capital={{ total: 10_000, committed: 5_000 }} onUpdate={noop} onRemove={noop} />,
    );
    expect(html).toContain("free to allocate");
  });

  it("marks an agent the supervisor halted", () => {
    const halted = snapshot({
      config: { ...snapshot().config, status: "SUPERVISOR_PAUSED" },
      supervisor: {
        state: "PAUSED",
        headline: "Paused after a 12.0% drawdown on allocated capital.",
        observations: [],
        adjustments: [],
      },
    });
    const html = renderToStaticMarkup(
      <AgentsView agents={[halted]} capital={{ total: 10_000, committed: 5_000 }} onUpdate={noop} onRemove={noop} />,
    );
    expect(html).toContain("SUPERVISOR PAUSED");
    expect(html).toContain("drawdown");
  });

  it("renders without a win rate when nothing has closed yet", () => {
    const fresh = snapshot({
      performance: { ...snapshot().performance, closedTrades: 0, wins: 0, winRate: 0, netPnl: 0 },
    });
    const html = renderToStaticMarkup(
      <AgentsView agents={[fresh]} capital={{ total: 10_000, committed: 5_000 }} onUpdate={noop} onRemove={noop} />,
    );
    expect(html).not.toContain("NaN");
  });
});

describe("PortfolioView", () => {
  const portfolio: Portfolio = {
    totalCapital: 10_000, committed: 5_000, uncommitted: 5_000, equity: 10_320,
    realisedPnl: 320, openPositions: 1, closedTrades: 12, winRate: 66.7,
    agents: [{ id: "a-1", name: "Trend follower", mode: "PAPER", status: "ACTIVE", allocated: 5_000, equity: 5_320, netPnl: 320, openPositions: 1 }],
    updatedAt: Date.now(),
  };

  it("shows capital, equity and results together", () => {
    const html = renderToStaticMarkup(<PortfolioView portfolio={portfolio} />);
    expect(html).toContain("$10,320");
    expect(html).toContain("$320");
    expect(html).toContain("Trend follower");
  });

  it("says when no agent holds capital", () => {
    const html = renderToStaticMarkup(<PortfolioView portfolio={{ ...portfolio, agents: [] }} />);
    expect(html).toContain("No agents are holding capital");
  });
});

describe("TradesView", () => {
  const trade: AgentTrade = {
    id: "POS-1", agentId: "a-1", agentName: "Trend follower", symbol: "BTCUSDT",
    direction: "LONG", entryModel: "SWEEP", entry: 64_000, currentPrice: 65_200,
    stopLoss: 63_500, sl: 64_000, takeProfits: [65_200], positionSize: 0.018,
    notional: 1_152, status: "CLOSED", closeReason: "TAKE_PROFIT", finalPnl: 21.6,
    realizedPnl: 21.6, unrealizedPnl: 0, entryFee: 0.46,
    openedAt: Date.now() - 7_200_000, closedAt: Date.now() - 3_600_000,
    plannedRr: [3], mae: 120, mfe: 1_400,
  };

  it("explains the empty state as a valid outcome", () => {
    const html = renderToStaticMarkup(<TradesView trades={[]} />);
    expect(html).toContain("No trades yet");
    expect(html).toMatch(/does not trade to fill a quota/);
  });

  it("shows which agent took the trade and how it closed", () => {
    const html = renderToStaticMarkup(<TradesView trades={[trade]} />);
    expect(html).toContain("Trend follower");
    expect(html).toContain("BTCUSDT");
    expect(html).toContain("TAKE PROFIT");
    expect(html).toContain("$21.6");
  });
});

describe("ConditionsView", () => {
  it("renders a classified market with its reasoning", () => {
    const html = renderToStaticMarkup(
      <ConditionsView
        updatedAt={Date.now()}
        conditions={[{
          symbol: "BTCUSDT", regime: "TRENDING_UP", confidence: 0.7,
          volatilityPct: 1.2, efficiency: 0.42,
          detail: "Price is travelling with 42% efficiency and structure is bullish.",
        }]}
      />,
    );
    expect(html).toContain("TRENDING UP");
    expect(html).toContain("42% efficiency");
  });

  it("says nothing has been classified rather than showing an empty grid", () => {
    const html = renderToStaticMarkup(<ConditionsView conditions={[]} updatedAt={null} />);
    expect(html).toContain("No conditions recorded yet");
  });
});

describe("NewsView", () => {
  const news: NewsResult = {
    items: [{
      id: "n-1", title: "Exchange hack drains funds", url: "https://x/1",
      source: "CoinDesk", publishedAt: Date.now() - 600_000,
      symbols: ["SOLUSDT"], sentiment: "NEGATIVE",
    }],
    fetchedAt: Date.now(),
    sources: [{ name: "CoinDesk", ok: true, detail: "1 items" }],
    unavailable: false,
  };

  it("shows headlines with their market and tone", () => {
    const html = renderToStaticMarkup(<NewsView news={news} />);
    expect(html).toContain("Exchange hack drains funds");
    expect(html).toContain("SOLUSDT");
    expect(html).toContain("NEGATIVE");
  });

  it("states that news never opens a position", () => {
    const html = renderToStaticMarkup(<NewsView news={news} />);
    expect(html).toMatch(/never opens a position/);
  });

  it("distinguishes an unreachable feed from quiet markets", () => {
    const html = renderToStaticMarkup(
      <NewsView news={{ items: [], fetchedAt: Date.now(), unavailable: true, sources: [{ name: "CoinDesk", ok: false, detail: "DNS failure" }] }} />,
    );
    expect(html).toContain("unreachable");
    expect(html).toContain("not quiet markets");
    expect(html).toContain("DNS failure");
  });
});
