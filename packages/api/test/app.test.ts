import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Candle, MarketDataProvider, RiskConfig, StrategyConfig, Timeframe } from "@smc/core";
import { DEFAULT_RISK_CONFIG, DEFAULT_STRATEGY_CONFIG, TIMEFRAME_DURATION_MS, InMemoryMarketData } from "@smc/core";
import { ApiApp } from "../src/app.js";

const TEST_STRATEGY: StrategyConfig = {
  ...DEFAULT_STRATEGY_CONFIG,
  minRr: 1,
  tp1MinRr: 1,
  entryModels: { aggressive: false, confirmation: true, sweep: false, counterTrend: false },
};

const TEST_RISK: RiskConfig = {
  ...DEFAULT_RISK_CONFIG,
  maxSymbolExposurePct: 500,
};

function mkCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  openTime: number,
  timeframe: Timeframe,
): Candle {
  return {
    symbol: "BTCUSDT",
    exchange: "test",
    timeframe,
    timestamp: openTime,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

function trendUnits(
  count: number,
  firstTrough: number,
  step: number,
  timeframe: Timeframe,
  startTime = 1_700_000_000_000,
): Candle[] {
  const dur = TIMEFRAME_DURATION_MS[timeframe];
  const out: Candle[] = [];
  let t = startTime;
  for (let k = 0; k < count; k++) {
    const T = firstTrough + k * step;
    const H = T + 2.2;
    const Tp = T + step;
    const moves: Array<[number, number, number, number]> = [
      [T + 0.2, T + 1.2, T + 0.1, T + 1.0],
      [T + 1.0, H, T + 0.9, H - 0.1],
      [H - 0.1, H - 0.2, H - 1.6, H - 1.7],
      [H - 1.7, H - 1.5, Tp, Tp + 0.1],
    ];
    for (const [o, h, l, c] of moves) {
      out.push(mkCandle(o, h, l, c, t, timeframe));
      t += dur;
    }
  }
  return out;
}

function bullishReversalLtf(startTime: number): Candle[] {
  const dur = TIMEFRAME_DURATION_MS["15M"];
  const base = trendUnits(6, 100, -0.5, "15M", startTime);
  const first = base[base.length - 1].timestamp + dur;
  const moves: Array<[number, number, number, number]> = [
    [97.8, 98.1, 97.25, 97.5],
    [97.5, 103.0, 97.4, 102.9],
    [102.9, 103.2, 101.2, 101.4],
    [101.4, 101.7, 99.6, 99.8],
    [99.8, 100.1, 98.5, 98.7],
    [98.7, 99.0, 98.0, 98.1],
    [98.1, 98.6, 97.8, 98.3],
  ];
  const out: Candle[] = [...base];
  for (let i = 0; i < moves.length; i++) {
    const [o, h, l, c] = moves[i];
    out.push(mkCandle(o, h, l, c, first + i * dur, "15M"));
  }
  return out;
}

function dataset(): Record<string, Candle[]> {
  const fourH = trendUnits(8, 90, 0.4, "4H", 1_700_000_000_000);
  const oneH = trendUnits(8, 90, 0.4, "1H", 1_700_040_000_000);
  const last4H = fourH[fourH.length - 1].timestamp;
  const ltfStart = last4H + TIMEFRAME_DURATION_MS["4H"];
  return {
    "4H": fourH,
    "1H": oneH,
    "15M": bullishReversalLtf(ltfStart),
  };
}

describe("api app", () => {
  let app: ApiApp;
  let base: string;

  async function waitFor(check: () => Promise<boolean>, ms = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out waiting for condition");
  }

  function openWs(url: string): Promise<{ ws: WebSocket; nextMsg: () => Promise<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const queue: Record<string, unknown>[] = [];
      const waiters: Array<(m: Record<string, unknown>) => void> = [];
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("WebSocket connect timeout"));
      }, 5000);
      ws.on("message", (data: unknown) => {
        const m = JSON.parse(String(data)) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(m);
        else queue.push(m);
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("open", () => {
        clearTimeout(timer);
        resolve({
          ws,
          nextMsg: () =>
            new Promise((res) => {
              const queued = queue.shift();
              if (queued) res(queued);
              else waiters.push(res);
            }),
        });
      });
    });
  }

  beforeEach(async () => {
    const marketData = new InMemoryMarketData(dataset());
    app = new ApiApp({ marketData, strategy: TEST_STRATEGY, risk: TEST_RISK, mode: "PAPER" });
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${app.address?.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it("reports health and status", async () => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.status).toBe("ok");
    const status = await fetch(`${base}/api/status`).then((r) => r.json());
    expect(status.symbol).toBe("BTCUSDT");
    expect(status.mode).toBe("PAPER");
    expect(status.autoTrading).toBe(true);
  });

  it("serves config, markets, candles and ticker", async () => {
    const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
    expect(cfg.strategy.timeframes.ltf).toBe("15M");
    expect(cfg.risk.riskPerTrade).toBeGreaterThan(0);

    const markets = await fetch(`${base}/api/markets`).then((r) => r.json());
    expect(markets.markets).toContain("BTCUSDT");

    const candles = await fetch(
      `${base}/api/candles?timeframe=4H&start=0&end=9999999999999`,
    ).then((r) => r.json());
    expect(candles.candles.length).toBeGreaterThan(0);

    const ticker = await fetch(`${base}/api/ticker/BTCUSDT`).then((r) => r.json());
    expect(typeof ticker.price).toBe("number");
  });

  it("feeds candles and produces a valid LONG setup", async () => {
    const data = dataset();
    const all = [...data["4H"], ...data["1H"], ...data["15M"]];
    const res = await fetch(`${base}/api/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candles: all }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.candles).toBe(all.length);
    expect(body.validSetups).toBeGreaterThan(0);
    expect(body.executed).toBe(true);

    const analysis = await fetch(`${base}/api/analysis`).then((r) => r.json());
    expect(analysis.bias).toBe("BULLISH");

    const risk = await fetch(`${base}/api/risk`).then((r) => r.json());
    expect(risk.state.tradesToday).toBe(1);
    expect(risk.state.usedExposure).toBeGreaterThan(0);

    const positions = await fetch(`${base}/api/positions`).then((r) => r.json());
    expect(positions.open.length).toBeGreaterThan(0);

    const journal = await fetch(`${base}/api/journal`).then((r) => r.json());
    expect(journal.entries.some((e: { category: string }) => e.category === "TRADE")).toBe(true);
  });

  it("reevaluates without duplicating the trade", async () => {
    const data = dataset();
    const all = [...data["4H"], ...data["1H"], ...data["15M"]];
    await fetch(`${base}/api/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candles: all }),
    });
    const cycle = await fetch(`${base}/api/reevaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ price: 98.3 }),
    }).then((r) => r.json());
    expect(cycle.decisions.filter((d: { decision: string }) => d.decision === "EXECUTE").length).toBe(0);
  });

  it("toggles auto trading and safe mode", async () => {
    const off = await fetch(`${base}/api/autotrading`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }).then((r) => r.json());
    expect(off.enabled).toBe(false);

    const safe = await fetch(`${base}/api/safemode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    }).then((r) => r.json());
    expect(safe.safetyBlocked).toBe(true);

    const exited = await fetch(`${base}/api/safemode/exit`, { method: "POST" }).then((r) => r.json());
    expect(exited.safetyBlocked).toBe(false);

    const activity = await fetch(`${base}/api/activity`).then((r) => r.json());
    expect(activity.events.length).toBeGreaterThan(0);
  });

  it("runs a backtest over the loaded data", async () => {
    const res = await fetch(`${base}/api/backtest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startTime: 1_700_000_000_000,
        endTime: 1_700_500_000_000,
        startingEquity: 10000,
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(typeof body.stats).toBe("object");
    expect(typeof body.stats.totalTrades).toBe("number");
    expect(body.validSetups).toBeGreaterThan(0);
  });

  it("returns 404 for unknown routes and 400 for bad bodies", async () => {
    const notFound = await fetch(`${base}/api/nope`);
    expect(notFound.status).toBe(404);

    const bad = await fetch(`${base}/api/backtest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    const badJson = await fetch(`${base}/api/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(badJson.status).toBe(500);
  });

  it("enters safe mode when the market data feed is down (failsafe)", async () => {
    const failing: MarketDataProvider = {
      name: "fail",
      getOHLCV: async () => {
        throw new Error("market data unavailable");
      },
      getTicker: async () => {
        throw new Error("market data unavailable");
      },
      getMarkets: async () => ["BTCUSDT"],
    };
    const app2 = new ApiApp({
      marketData: failing,
      strategy: TEST_STRATEGY,
      risk: TEST_RISK,
      mode: "PAPER",
      feed: { safeModeThreshold: 1 },
    });
    await app2.listen(0, "127.0.0.1");
    const b = `http://127.0.0.1:${app2.address?.port}`;
    try {
      let status: { safetyBlocked: boolean };
      await waitFor(async () => {
        status = await fetch(`${b}/api/status`).then((r) => r.json());
        return status!.safetyBlocked === true;
      });
      expect(status!.safetyBlocked).toBe(true);
      const stats = app2.feed?.getStats();
      expect(stats?.safeModeTriggered).toBe(true);
      expect(stats?.consecutiveErrors).toBeGreaterThanOrEqual(1);
      expect(stats?.lastError).toContain("market data unavailable");
    } finally {
      await app2.close();
    }
  });

  it("updates config with platform ceiling clamping applied in the backend", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        risk: { maxTradesPerDay: 20, riskPerTrade: 50, maxDailyLossPct: 99, maxDrawdownPct: 5 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Values above the platform ceiling are clamped, not accepted (section 62).
    expect(body.risk.maxTradesPerDay).toBe(15);
    expect(body.risk.riskPerTrade).toBe(5);
    expect(body.risk.maxDailyLossPct).toBe(10);
    // Values below the floor are raised to the floor where applicable.
    expect(body.risk.maxDrawdownPct).toBe(5);

    // The engine's risk config is the authoritative clamped copy.
    expect(app.engine.riskLimits.maxTradesPerDay).toBe(15);
    expect(app.engine.riskLimits.riskPerTrade).toBe(5);

    // GET reflects the updated (clamped) config.
    const get = await fetch(`${base}/api/config`).then((r) => r.json());
    expect(get.risk.maxTradesPerDay).toBe(15);
  });

  it("rejects structural strategy changes and out-of-range strategy values", async () => {
    const structural = await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: { timeframes: { htf: "1D", mtf: "4H", ltf: "1H" } } }),
    });
    expect(structural.status).toBe(400);

    const badRr = await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: { minRr: 0.1 } }),
    });
    expect(badRr.status).toBe(400);
  });

  it("applies a lowered daily trade limit immediately", async () => {
    await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ risk: { maxTradesPerDay: 1 } }),
    });
    const data = dataset();
    const all = [...data["4H"], ...data["1H"], ...data["15M"]];
    const res = await fetch(`${base}/api/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candles: all }),
    });
    const body = await res.json();
    expect(body.executed).toBe(true);

    const risk = await fetch(`${base}/api/risk`).then((r) => r.json());
    expect(risk.state.tradesToday).toBeLessThanOrEqual(1);
  });

  it("exposes per-setup explanations from the analysis endpoint", async () => {
    const data = dataset();
    const all = [...data["4H"], ...data["1H"], ...data["15M"]];
    await fetch(`${base}/api/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candles: all }),
    });
    const analysis = await fetch(`${base}/api/analysis`).then((r) => r.json());
    const first = analysis.setups[0];
    expect(first.explanation).toBeDefined();
    expect(typeof first.explanation.headline).toBe("string");
    expect(Array.isArray(first.explanation.lines)).toBe(true);
    expect(first.explanation.lines.length).toBeGreaterThan(0);
  });

  it("streams real-time state and activity over a WebSocket", async () => {
    const port = app.address?.port;
    expect(port).toBeDefined();
    const conn = await openWs(`ws://127.0.0.1:${port}/ws`);
    try {
      // A new client immediately receives the full state snapshot.
      const initial = await conn.nextMsg();
      expect(initial.type).toBe("state");
      expect((initial.payload as { status: { symbol: string } }).status.symbol).toBe("BTCUSDT");

      // Mutations stream granular activity events immediately.
      await fetch(`${base}/api/autotrading`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      const activity = await conn.nextMsg();
      expect(activity.type).toBe("activity");
      expect((activity.event as { kind: string }).kind).toBe("autotrading");

      // A follow-up state snapshot reflects the change.
      const state = await conn.nextMsg();
      expect(state.type).toBe("state");
      expect((state.payload as { status: { autoTrading: boolean } }).status.autoTrading).toBe(false);
    } finally {
      conn.ws.close();
    }
  });
});
