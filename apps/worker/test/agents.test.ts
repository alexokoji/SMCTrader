import { describe, expect, it } from "vitest";
import type { Timeframe } from "@smc/core";
import { AgentRuntime, SYMBOL_BUDGET_PER_TICK, defaultAgentConfig } from "../src/agents.js";
import type { RuntimeStorage } from "../src/runtime.js";

/**
 * End-to-end cover for the agent lifecycle: create, fund, analyse, supervise.
 * Market data is stubbed so the run is deterministic, but everything below the
 * feed is the real engine, the real risk checks and the real supervisor.
 */

const HOUR = 3_600_000;

function memoryStorage(): RuntimeStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(entries: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    },
  };
}

function stubFetch(now: number): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const interval = url.searchParams.get("interval");
    const tf: Timeframe = interval === "4h" ? "4H" : interval === "1h" ? "1H" : "15M";
    const step = tf === "4H" ? 4 * HOUR : tf === "1H" ? HOUR : HOUR / 4;

    let price = 60_000;
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    const rows = Array.from({ length: 200 }, (_, i) => {
      const open = price;
      const close = open + rnd() * 700;
      price = close;
      return [
        now - (199 - i) * step,
        String(open),
        String(Math.max(open, close) + 220),
        String(Math.min(open, close) - 220),
        String(close),
        "10",
      ];
    });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
}

const NOW = 1_800_000_000_000;

function runtime() {
  const storage = memoryStorage();
  return { storage, agents: new AgentRuntime(storage, { fetchFn: stubFetch(NOW) }) };
}

const baseInput = {
  id: "agent-1",
  name: "Trend follower",
  mode: "PAPER" as const,
  allocatedCapital: 5_000,
  symbols: ["BTCUSDT"],
};

describe("agent lifecycle", () => {
  it("creates and funds an agent from available capital", async () => {
    const { agents } = runtime();
    const result = await agents.create(baseInput, 10_000);

    expect(result.error).toBeUndefined();
    expect(result.agent!.name).toBe("Trend follower");
    expect(result.agent!.allocatedCapital).toBe(5_000);
    expect(result.agent!.status).toBe("ACTIVE");
    // Working settings start at the baseline; only the supervisor moves them.
    expect(result.agent!.working).toEqual(result.agent!.baseline);
  });

  it("refuses to commit capital twice", async () => {
    const { agents } = runtime();
    await agents.create(baseInput, 10_000);
    const second = await agents.create(
      { ...baseInput, id: "agent-2", name: "Second", allocatedCapital: 6_000 },
      10_000,
    );

    expect(second.agent).toBeUndefined();
    expect(second.error).toMatch(/uncommitted/);
  });

  it("refuses an agent with no markets", async () => {
    const { agents } = runtime();
    const result = await agents.create({ ...baseInput, symbols: [] }, 10_000);
    expect(result.error).toMatch(/at least one market/);
  });

  it("frees capital when an agent is stopped", async () => {
    const { agents } = runtime();
    await agents.create(baseInput, 10_000);
    await agents.update("agent-1", { status: "STOPPED" }, 10_000);

    const second = await agents.create(
      { ...baseInput, id: "agent-2", name: "Second", allocatedCapital: 9_000 },
      10_000,
    );
    expect(second.error).toBeUndefined();
  });

  it("analyses its markets and reports what it found", async () => {
    const { agents } = runtime();
    await agents.create(baseInput, 10_000);

    const results = await agents.tickAll(NOW);
    expect(results).toHaveLength(1);

    const [result] = results;
    expect(result.name).toBe("Trend follower");
    expect(result.ticks).toHaveLength(1);
    // The real engine ran: per-timeframe structure exists.
    expect(result.ticks[0].analysis.snapshots["4H"]).toBeDefined();
    expect(result.regimes.BTCUSDT).toBeDefined();
    expect(result.regimes.BTCUSDT.regime).toBeTruthy();
  });

  it("sizes against its own allocation, not a shared balance", async () => {
    const { agents } = runtime();
    await agents.create({ ...baseInput, allocatedCapital: 2_500 }, 10_000);
    await agents.tickAll(NOW);

    const performance = await agents.performanceOf((await agents.list())[0]);
    // With nothing closed, equity is exactly the allocation.
    expect(performance.equity).toBe(2_500);
    expect(performance.closedTrades).toBe(0);
  });

  it("keeps agents isolated from one another", async () => {
    const { agents } = runtime();
    await agents.create(baseInput, 20_000);
    await agents.create(
      { ...baseInput, id: "agent-2", name: "Second", allocatedCapital: 4_000, symbols: ["ETHUSDT"] },
      20_000,
    );

    await agents.tickAll(NOW);
    const list = await agents.list();
    const first = await agents.performanceOf(list[0]);
    const second = await agents.performanceOf(list[1]);

    expect(first.equity).toBe(5_000);
    expect(second.equity).toBe(4_000);
    // Separate engines: one agent's runtime does not hold the other's market.
    expect(agents.engineRuntimeFor("agent-1")?.engineFor("ETHUSDT")).toBeUndefined();
  });

  it("bounds the work one invocation can do however many agents exist", async () => {
    const { agents } = runtime();
    for (let i = 0; i < 5; i++) {
      await agents.create(
        {
          ...baseInput,
          id: `agent-${i}`,
          name: `Agent ${i}`,
          allocatedCapital: 1_000,
          symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        },
        50_000,
      );
    }

    const results = await agents.tickAll(NOW);
    const analysed = results.reduce((sum, r) => sum + r.ticks.length, 0);
    // 15 symbols exist; only the budget is analysed per invocation.
    expect(analysed).toBeLessThanOrEqual(SYMBOL_BUDGET_PER_TICK);
  });

  it("rotates which markets are analysed so none is starved", async () => {
    const { agents } = runtime();
    await agents.create(
      { ...baseInput, symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"] },
      10_000,
    );

    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const results = await agents.tickAll(NOW);
      for (const tick of results[0].ticks) seen.add(tick.symbol);
    }
    // Rotation reaches markets beyond the first budget's worth.
    expect(seen.size).toBeGreaterThan(SYMBOL_BUDGET_PER_TICK);
  });

  it("skips agents that are not active", async () => {
    const { agents } = runtime();
    await agents.create(baseInput, 10_000);
    await agents.update("agent-1", { status: "PAUSED" }, 10_000);

    expect(await agents.tickAll(NOW)).toEqual([]);
  });

  it("restores baseline settings when a supervisor-paused agent is resumed", async () => {
    const { storage, agents } = runtime();
    await agents.create(baseInput, 10_000);

    // Simulate the supervisor having tightened and halted the agent.
    const list = await agents.list();
    await storage.put({
      agents: [{
        ...list[0],
        status: "SUPERVISOR_PAUSED",
        working: { riskPerTrade: 0.25, minRr: 5, minScore: 80 },
      }],
    });

    const resumed = await agents.update("agent-1", { status: "ACTIVE" }, 10_000);
    expect(resumed.agent!.working).toEqual(resumed.agent!.baseline);
  });

  it("reports a supervisor verdict for every agent", async () => {
    const { agents } = runtime();
    await agents.create(baseInput, 10_000);
    await agents.tickAll(NOW);

    const snapshots = await agents.snapshots();
    expect(snapshots).toHaveLength(1);
    // No trades yet, so the supervisor withholds judgement rather than guessing.
    expect(snapshots[0].supervisor.state).toBe("OBSERVING");
    expect(snapshots[0].supervisor.headline).toMatch(/trades needed/);
  });

  it("reports positions the engines are not currently holding in memory", async () => {
    const { storage, agents } = runtime();
    await agents.create({ ...baseInput, symbols: ["BTCUSDT", "ETHUSDT"] }, 10_000);

    // A closed trade persisted for a market whose engine is not warm. Rotation
    // means most engines are cold at any moment, and an eviction makes them all
    // cold, so reading only memory hid trades that had genuinely happened.
    storage.data.set("engine:agent-1:ETHUSDT", {
      snapshot: {
        positions: [{
          id: "POS-COLD", symbol: "ETHUSDT", direction: "LONG", setupId: "s-1",
          status: "CLOSED", finalPnl: 42.5, realizedPnl: 42.5, openedAt: 1, closedAt: 2,
          entry: 100, currentPrice: 110, stopLoss: 95, sl: 95, takeProfits: [110],
          positionSize: 1, notional: 100, entryFee: 0, unrealizedPnl: 0,
          quantityRemaining: 0, closedQuantity: 1, mae: 0, mfe: 0, events: [],
          exchange: "t", strategyVersion: "v1", partialPlan: [],
        }],
      },
    });

    const trades = await agents.trades();
    expect(trades.map((t) => t.id)).toContain("POS-COLD");

    const performance = await agents.performanceOf((await agents.list())[0]);
    expect(performance.closedTrades).toBe(1);
    expect(performance.netPnl).toBeCloseTo(42.5, 6);
  });

  it("shows the same trades on the agent card as on the trades list", async () => {
    const { storage, agents } = runtime();
    await agents.create({ ...baseInput, symbols: ["BTCUSDT", "ETHUSDT"] }, 10_000);

    for (const [symbol, pnl] of [["BTCUSDT", 10], ["ETHUSDT", -4]] as const) {
      storage.data.set(`engine:agent-1:${symbol}`, {
        snapshot: {
          positions: [{
            id: `POS-${symbol}`, symbol, direction: "LONG", setupId: "s", status: "CLOSED",
            finalPnl: pnl, realizedPnl: pnl, openedAt: 1, closedAt: 2,
            entry: 100, currentPrice: 100 + pnl, stopLoss: 95, sl: 95, takeProfits: [110],
            positionSize: 1, notional: 100, entryFee: 0, unrealizedPnl: 0,
            quantityRemaining: 0, closedQuantity: 1, mae: 0, mfe: 0, events: [],
            exchange: "t", strategyVersion: "v1", partialPlan: [],
          }],
        },
      });
    }

    const [snapshot] = await agents.snapshots();
    const trades = await agents.trades();
    const closedOnList = trades.filter((t) => t.status === "CLOSED");

    // The card's count and the list's rows are the same positions.
    expect(snapshot.performance.closedTrades).toBe(closedOnList.length);
    expect(snapshot.performance.netPnl).toBeCloseTo(
      closedOnList.reduce((sum, t) => sum + (t.finalPnl ?? t.realizedPnl), 0),
      6,
    );
  });

  it("prefers the warm engine over the stored snapshot for the same market", async () => {
    const { storage, agents } = runtime();
    await agents.create(baseInput, 10_000);
    await agents.tickAll(NOW);

    // A stale snapshot must not add a phantom position alongside the live engine.
    storage.data.set("engine:agent-1:BTCUSDT", {
      snapshot: { positions: [{ id: "POS-STALE", symbol: "BTCUSDT", status: "CLOSED" }] },
    });

    const trades = await agents.trades();
    expect(trades.map((t) => t.id)).not.toContain("POS-STALE");
  });

  it("removes an agent and its commitment", async () => {
    const { agents } = runtime();
    await agents.create(baseInput, 10_000);

    expect(await agents.remove("agent-1")).toBe(true);
    expect(await agents.list()).toEqual([]);
    expect(await agents.remove("agent-1")).toBe(false);
  });

  it("survives a market data outage without losing the agent", async () => {
    const storage = memoryStorage();
    const failing = new AgentRuntime(storage, {
      fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    });
    await failing.create(baseInput, 10_000);

    // The tick must not throw; a feed outage is not an agent failure.
    await expect(failing.tickAll(NOW)).resolves.toBeDefined();
    expect(await failing.list()).toHaveLength(1);
  });
});

describe("defaultAgentConfig", () => {
  it("starts working settings equal to the baseline", () => {
    const config = defaultAgentConfig({ ...baseInput, minRr: 4, riskPerTrade: 0.5 });
    expect(config.baseline).toEqual({ riskPerTrade: 0.5, minRr: 4, minScore: 60 });
    expect(config.working).toEqual(config.baseline);
  });

  it("defaults to the confirmation and sweep models", () => {
    expect(defaultAgentConfig(baseInput).entryModels).toEqual(["CONFIRMATION", "SWEEP"]);
  });
});
