/**
 * Agent runtime.
 *
 * Each agent is an independent trader: its own capital, markets, engine state
 * and risk limits. Agents share candle buffers, because market data is the same
 * for everyone, but nothing else — one agent's losses cannot spend another's
 * capital or trip another's limits.
 *
 * Every agent gets an analysis pass and, separately, a supervision pass. The
 * analysis decides what to trade; the supervisor decides whether the analysis
 * is still worth acting on.
 */
import {
  DEFAULT_RISK_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  DEFAULT_SUPERVISOR_THRESHOLDS,
  checkAllocation,
  classifyRegime,
  computePerformance,
  relaxAgent,
  reviewAgent,
  type AgentAdjustment,
  type AgentConfig,
  type AgentPerformance,
  type AgentSnapshot,
  type EntryModel,
  type ManagedPosition,
  type RegimeReading,
  type Setup,
  type SupervisorVerdict,
} from "@smc/core";
import { TradingRuntime, type AnalysisTick, type RuntimeStorage } from "./runtime.js";

/** Symbols analysed per invocation across all agents, to bound CPU per alarm. */
export const SYMBOL_BUDGET_PER_TICK = 6;

export interface AgentTickResult {
  agentId: string;
  name: string;
  ticks: AnalysisTick[];
  performance: AgentPerformance;
  supervisor: SupervisorVerdict;
  applied: AgentAdjustment[];
  regimes: Record<string, RegimeReading>;
  skipped?: string;
}

function agentKey(id: string): string {
  return `agent:${id}`;
}

export function defaultAgentConfig(input: {
  id: string;
  name: string;
  mode: AgentConfig["mode"];
  allocatedCapital: number;
  symbols: string[];
  entryModels?: EntryModel[];
  riskPerTrade?: number;
  minRr?: number;
  minScore?: number;
  requiredRegimes?: string[];
}): AgentConfig {
  const baseline = {
    riskPerTrade: input.riskPerTrade ?? DEFAULT_RISK_CONFIG.riskPerTrade,
    minRr: input.minRr ?? DEFAULT_STRATEGY_CONFIG.minRr,
    minScore: input.minScore ?? 60,
  };
  const now = Date.now();
  return {
    id: input.id,
    name: input.name,
    mode: input.mode,
    allocatedCapital: input.allocatedCapital,
    symbols: input.symbols,
    timeframes: DEFAULT_STRATEGY_CONFIG.timeframes,
    entryModels: input.entryModels ?? ["CONFIRMATION", "SWEEP"],
    baseline,
    // Working values start at the baseline and only the supervisor moves them.
    working: { ...baseline },
    requiredRegimes: input.requiredRegimes ?? [],
    maxOpenPositions: DEFAULT_RISK_CONFIG.maxOpenPositions,
    maxDailyLossPct: DEFAULT_RISK_CONFIG.maxDailyLossPct,
    maxDrawdownPct: DEFAULT_SUPERVISOR_THRESHOLDS.pauseDrawdownPct,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
}

export class AgentRuntime {
  private readonly storage: RuntimeStorage;
  private readonly runtimes = new Map<string, TradingRuntime>();
  private readonly fetchFn?: typeof fetch;
  /** Rotates which symbols are analysed when more exist than the budget allows. */
  private cursor = 0;

  constructor(storage: RuntimeStorage, opts: { fetchFn?: typeof fetch } = {}) {
    this.storage = storage;
    this.fetchFn = opts.fetchFn;
  }

  async list(): Promise<AgentConfig[]> {
    return (await this.storage.get<AgentConfig[]>("agents")) ?? [];
  }

  private async save(agents: AgentConfig[]): Promise<void> {
    await this.storage.put({ agents });
  }

  async create(
    input: Parameters<typeof defaultAgentConfig>[0],
    totalCapital: number,
  ): Promise<{ agent?: AgentConfig; error?: string }> {
    const agents = await this.list();
    if (agents.length >= 20) return { error: "An account is limited to 20 agents." };
    if (!input.symbols.length) return { error: "An agent needs at least one market." };

    const check = checkAllocation(input.allocatedCapital, totalCapital, agents);
    if (!check.ok) return { error: check.reason };

    const agent = defaultAgentConfig(input);
    await this.save([...agents, agent]);
    return { agent };
  }

  async update(
    id: string,
    patch: Partial<Pick<AgentConfig, "name" | "status" | "allocatedCapital" | "symbols" | "entryModels" | "requiredRegimes">>,
    totalCapital: number,
  ): Promise<{ agent?: AgentConfig; error?: string }> {
    const agents = await this.list();
    const existing = agents.find((a) => a.id === id);
    if (!existing) return { error: "No agent with that id." };

    if (patch.allocatedCapital !== undefined) {
      const check = checkAllocation(patch.allocatedCapital, totalCapital, [], id, agents);
      if (!check.ok) return { error: check.reason };
    }

    const updated: AgentConfig = {
      ...existing,
      ...patch,
      // Resuming a supervisor-paused agent restores its baseline settings, so a
      // deliberate restart is not silently crippled by earlier tightening.
      working: patch.status === "ACTIVE" && existing.status === "SUPERVISOR_PAUSED"
        ? { ...existing.baseline }
        : existing.working,
      updatedAt: Date.now(),
    };
    await this.save(agents.map((a) => (a.id === id ? updated : a)));
    return { agent: updated };
  }

  async remove(id: string): Promise<boolean> {
    const agents = await this.list();
    if (!agents.some((a) => a.id === id)) return false;
    await this.save(agents.filter((a) => a.id !== id));
    return true;
  }

  private runtimeFor(agent: AgentConfig): TradingRuntime {
    let runtime = this.runtimes.get(agent.id);
    if (!runtime) {
      runtime = new TradingRuntime(this.storage, {
        fetchFn: this.fetchFn,
        namespace: agent.id,
      });
      this.runtimes.set(agent.id, runtime);
    }
    return runtime;
  }

  /** Every closed and open position the agent's engines are holding. */
  private positionsOf(agent: AgentConfig): ManagedPosition[] {
    const runtime = this.runtimes.get(agent.id);
    if (!runtime) return [];
    return agent.symbols.flatMap((symbol) => runtime.engineFor(symbol)?.getPositions() ?? []);
  }

  private setupsOf(agent: AgentConfig): Setup[] {
    const runtime = this.runtimes.get(agent.id);
    if (!runtime) return [];
    return agent.symbols.flatMap((symbol) => {
      const engine = runtime.engineFor(symbol);
      return engine ? engine.analysis.analyze().setups : [];
    });
  }

  /**
   * Realised performance for one agent, measured against its own allocation
   * rather than a global account balance.
   */
  performanceOf(agent: AgentConfig): AgentPerformance {
    const positions = this.positionsOf(agent);
    const closed = positions.filter((p) => p.status === "CLOSED");
    const wins = closed.filter((p) => (p.finalPnl ?? p.realizedPnl) > 0).length;
    const netPnl = closed.reduce((sum, p) => sum + (p.finalPnl ?? p.realizedPnl), 0);

    const performance = computePerformance({
      positions,
      setups: this.setupsOf(agent),
      equityCurve: [],
      startingEquity: agent.allocatedCapital,
    });

    // Consecutive losses are counted from the most recent close backwards,
    // because a streak in progress is what the supervisor reacts to.
    const byClose = [...closed].sort(
      (a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt),
    );
    let consecutiveLosses = 0;
    for (const position of byClose) {
      if ((position.finalPnl ?? position.realizedPnl) > 0) break;
      consecutiveLosses++;
    }

    const equity = agent.allocatedCapital + netPnl;
    const peak = Math.max(agent.allocatedCapital, equity);
    const drawdownPct = peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0;

    return {
      closedTrades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? (wins / closed.length) * 100 : 0,
      netPnl,
      profitFactor: performance.stats.profitFactor,
      consecutiveLosses,
      drawdownPct,
      equity,
      openPositions: positions.filter((p) => p.status === "OPEN").length,
    };
  }

  /**
   * Run one pass over every active agent. Symbols are rotated so a large number
   * of agents cannot put unbounded work into a single invocation.
   */
  async tickAll(now = Date.now()): Promise<AgentTickResult[]> {
    const agents = await this.list();
    const active = agents.filter((a) => a.status === "ACTIVE");
    const results: AgentTickResult[] = [];

    // Build a flat, rotating work list so every symbol is reached in turn.
    const work: { agent: AgentConfig; symbol: string }[] = active.flatMap((agent) =>
      agent.symbols.map((symbol) => ({ agent, symbol })),
    );
    if (work.length === 0) return results;

    const slice: typeof work = [];
    for (let i = 0; i < Math.min(SYMBOL_BUDGET_PER_TICK, work.length); i++) {
      slice.push(work[(this.cursor + i) % work.length]);
    }
    this.cursor = (this.cursor + slice.length) % work.length;

    const byAgent = new Map<string, string[]>();
    for (const item of slice) {
      byAgent.set(item.agent.id, [...(byAgent.get(item.agent.id) ?? []), item.symbol]);
    }

    let mutated = false;
    const next = [...agents];

    for (const agent of active) {
      const symbols = byAgent.get(agent.id);
      if (!symbols?.length) continue;

      const runtime = this.runtimeFor(agent);
      const ticks: AnalysisTick[] = [];
      const regimes: Record<string, RegimeReading> = {};

      for (const symbol of symbols) {
        const tick = await runtime.tick(symbol, {
          mode: agent.mode === "LIVE" ? "LIVE" : "PAPER",
          risk: {
            ...DEFAULT_RISK_CONFIG,
            riskPerTrade: agent.working.riskPerTrade,
            maxOpenPositions: agent.maxOpenPositions,
            maxDailyLossPct: agent.maxDailyLossPct,
            maxDrawdownPct: agent.maxDrawdownPct,
          },
          strategy: {
            minRr: agent.working.minRr,
            entryModels: {
              aggressive: agent.entryModels.includes("AGGRESSIVE"),
              confirmation: agent.entryModels.includes("CONFIRMATION"),
              sweep: agent.entryModels.includes("SWEEP"),
              counterTrend: agent.entryModels.includes("COUNTER_TREND"),
            },
          } as never,
          autoTrading: true,
          safetyBlocked: false,
          startingEquity: agent.allocatedCapital,
          now,
        });
        ticks.push(tick);

        const ltf = agent.timeframes.ltf;
        const snapshot = tick.analysis.snapshots[ltf];
        if (snapshot) {
          regimes[symbol] = classifyRegime(snapshot.candles, snapshot.structure.trend);
        }
      }

      const performance = this.performanceOf(agent);
      const verdict = reviewAgent(performance, agent.working);
      const applied: AgentAdjustment[] = [];

      if (verdict.state === "PAUSED") {
        const index = next.findIndex((a) => a.id === agent.id);
        if (index >= 0) {
          next[index] = { ...next[index], status: "SUPERVISOR_PAUSED", updatedAt: now };
          mutated = true;
        }
      } else if (verdict.adjustments.length) {
        applied.push(...verdict.adjustments);
      } else {
        applied.push(...relaxAgent(performance, agent.working, agent.baseline));
      }

      if (applied.length) {
        const index = next.findIndex((a) => a.id === agent.id);
        if (index >= 0) {
          const working = { ...next[index].working };
          for (const adjustment of applied) working[adjustment.field] = adjustment.to;
          next[index] = { ...next[index], working, updatedAt: now };
          mutated = true;
        }
        const history = (await this.storage.get<(AgentAdjustment & { at: number })[]>(agentKey(agent.id))) ?? [];
        await this.storage.put({
          [agentKey(agent.id)]: [...applied.map((a) => ({ ...a, at: now })), ...history].slice(0, 50),
        });
      }

      results.push({
        agentId: agent.id,
        name: agent.name,
        ticks,
        performance,
        supervisor: verdict,
        applied,
        regimes,
      });
    }

    if (mutated) await this.save(next);
    return results;
  }

  /** Everything the agents view needs, without the chart-sized payloads. */
  async snapshots(): Promise<AgentSnapshot[]> {
    const agents = await this.list();
    const out: AgentSnapshot[] = [];
    for (const agent of agents) {
      const performance = this.performanceOf(agent);
      out.push({
        config: agent,
        performance,
        supervisor: reviewAgent(performance, agent.working),
        adjustmentHistory:
          (await this.storage.get<(AgentAdjustment & { at: number })[]>(agentKey(agent.id))) ?? [],
      });
    }
    return out;
  }

  /** Closed and open positions across every agent, newest first. */
  async trades(): Promise<(ManagedPosition & { agentId: string; agentName: string })[]> {
    const agents = await this.list();
    return agents
      .flatMap((agent) =>
        this.positionsOf(agent).map((position) => ({
          ...position,
          agentId: agent.id,
          agentName: agent.name,
        })),
      )
      .sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
  }

  engineRuntimeFor(agentId: string): TradingRuntime | undefined {
    return this.runtimes.get(agentId);
  }
}
