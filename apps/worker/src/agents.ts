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
  dayKeyOf,
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

/**
 * Upper bound on markets analysed per invocation, as a runaway guard only.
 *
 * Every market an active agent selected is analysed on every tick. An earlier
 * version rotated through a small budget, which was the wrong trade: a rebuilt
 * engine costs about 62ms per market, so covering a realistic set of agents is
 * around a second of CPU, while rotating left each market analysed only once
 * every twenty minutes and agents acting on stale structure.
 *
 * This cap exists so an account that selects an implausible number of markets
 * cannot make one invocation unbounded; reaching it is reported, not silent.
 */
export const MAX_MARKETS_PER_TICK = 80;

export interface AgentTickResult {
  /** Markets still waiting for this rotation to reach them. */
  pendingMarkets?: number;
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

  /**
   * Start a new trading day for the account.
   *
   * A supervisor pause is otherwise a one-way door: a paused agent is dropped
   * from the active set, so it never ticks, so no new evidence ever reaches the
   * supervisor that could clear the pause. Each day a paused agent is returned
   * to its baseline settings and given another chance, which is what a limit
   * that resets daily means. Agents the operator paused or stopped by hand are
   * left exactly as they are — that decision is not the supervisor's to undo.
   */
  private async rolloverAgentsIfNewDay(now: number): Promise<boolean> {
    const today = dayKeyOf(now);
    const lastDay = await this.storage.get<string>("agentsDayKey");
    if (lastDay === today) return false;
    await this.storage.put({ agentsDayKey: today });

    // No recorded day means the account has never rolled over, so any pause it
    // is carrying was set when nothing could ever clear it. Those are released
    // here too; on a genuinely new account there is nothing to release.
    const agents = await this.list();
    const reset = agents.map((agent) =>
      agent.status === "SUPERVISOR_PAUSED"
        ? {
            ...agent,
            status: "ACTIVE" as const,
            working: { ...agent.baseline },
            lastSupervisedAtTrades: undefined,
            updatedAt: now,
          }
        : agent,
    );
    const resumed = reset.filter((a, i) => a.status !== agents[i].status).map((a) => a.name);
    if (resumed.length) {
      await this.save(reset);
      console.log(JSON.stringify({
        event: "agents_daily_reset",
        day: today,
        resumed,
        timestamp: now,
      }));
    }
    return resumed.length > 0;
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

  /**
   * Every position an agent holds, across all of its markets.
   *
   * A warm engine is preferred because it is the freshest, but only symbols
   * ticked in this Durable Object instance have one, and rotation means most do
   * not at any given moment. Falling back to the persisted snapshot makes the
   * answer the same whichever engines happen to be in memory, so the agent card
   * and the trades page cannot disagree, and neither empties after an eviction.
   */
  private async positionsOf(agent: AgentConfig): Promise<ManagedPosition[]> {
    const runtime = this.runtimes.get(agent.id);
    const positions: ManagedPosition[] = [];

    for (const symbol of agent.symbols) {
      const warm = runtime?.engineFor(symbol);
      if (warm) {
        positions.push(...warm.getPositions());
        continue;
      }
      const stored = await this.storage.get<{ snapshot?: { positions?: ManagedPosition[] } }>(
        `engine:${agent.id}:${symbol}`,
      );
      if (stored?.snapshot?.positions) positions.push(...stored.snapshot.positions);
    }

    // The same position can only come from one source, but a symbol renamed or
    // removed could leave a stale duplicate; key by id to be certain.
    return [...new Map(positions.map((p) => [p.id, p])).values()];
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
  async performanceOf(agent: AgentConfig): Promise<AgentPerformance> {
    const positions = await this.positionsOf(agent);
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
    await this.rolloverAgentsIfNewDay(now);
    const agents = await this.list();
    const active = agents.filter((a) => a.status === "ACTIVE");
    const results: AgentTickResult[] = [];

    // Every market of every active agent, analysed on this tick.
    const work: { agent: AgentConfig; symbol: string }[] = active.flatMap((agent) =>
      agent.symbols.map((symbol) => ({ agent, symbol })),
    );
    if (work.length === 0) return results;

    const covered = work.slice(0, MAX_MARKETS_PER_TICK);
    if (covered.length < work.length) {
      console.warn(JSON.stringify({
        event: "market_cap_reached",
        selected: work.length,
        analysed: covered.length,
        cap: MAX_MARKETS_PER_TICK,
        timestamp: now,
      }));
    }

    const byAgent = new Map<string, string[]>();
    for (const item of covered) {
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

      // Limits such as maximum open positions describe the agent, not one of
      // its markets. Each market runs its own engine, so every engine is told
      // what the others hold; otherwise an agent with ten markets could hold
      // ten times its configured maximum.
      const openAcrossAgent = (await this.positionsOf(agent)).filter((p) => p.status === "OPEN");
      const group = DEFAULT_RISK_CONFIG.correlationGroups;

      for (const symbol of symbols) {
        const elsewhere = openAcrossAgent.filter((p) => p.symbol !== symbol);
        const correlatedElsewhere = elsewhere.filter(
          (p) => group[p.symbol] !== undefined && group[p.symbol] === group[symbol],
        );
        const context = {
          openPositions: elsewhere.length,
          exposure: elsewhere.reduce((sum, p) => sum + p.notional, 0),
          correlatedExposure: correlatedElsewhere.reduce((sum, p) => sum + p.notional, 0),
        };

        // One market's feed failing must not abandon the agent's other markets,
        // nor the supervision pass that follows.
        try {
          const tick = await runtime.tick(symbol, {
            portfolio: context,
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
        } catch (error) {
          console.warn(JSON.stringify({
            event: "agent_symbol_failed",
            agent: agent.name,
            symbol,
            reason: error instanceof Error ? error.message : String(error),
            timestamp: now,
          }));
        }
      }

      const performance = await this.performanceOf(agent);
      const verdict = reviewAgent(performance, agent.working);
      const applied: AgentAdjustment[] = [];

      // The supervisor is stateless, so it reaches the same verdict on the same
      // evidence every tick. Only act when a trade has closed since the last
      // change, otherwise one losing streak compounds a fresh tightening every
      // few minutes and throttles a working agent toward zero.
      const seenEvidence = agent.lastSupervisedAtTrades ?? -1;
      const hasNewEvidence = performance.closedTrades > seenEvidence;

      if (verdict.state === "PAUSED") {
        const index = next.findIndex((a) => a.id === agent.id);
        if (index >= 0) {
          next[index] = { ...next[index], status: "SUPERVISOR_PAUSED", updatedAt: now };
          mutated = true;
        }
      } else if (hasNewEvidence && verdict.adjustments.length) {
        applied.push(...verdict.adjustments);
      } else if (hasNewEvidence) {
        applied.push(...relaxAgent(performance, agent.working, agent.baseline));
      }

      if (applied.length) {
        const index = next.findIndex((a) => a.id === agent.id);
        if (index >= 0) {
          const working = { ...next[index].working };
          for (const adjustment of applied) working[adjustment.field] = adjustment.to;
          next[index] = {
            ...next[index],
            working,
            lastSupervisedAtTrades: performance.closedTrades,
            updatedAt: now,
          };
          mutated = true;
        }
        const history = (await this.storage.get<(AgentAdjustment & { at: number })[]>(agentKey(agent.id))) ?? [];
        await this.storage.put({
          [agentKey(agent.id)]: [...applied.map((a) => ({ ...a, at: now })), ...history].slice(0, 50),
        });
      }

      results.push({
        pendingMarkets: Math.max(0, work.length - covered.length),
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
      const performance = await this.performanceOf(agent);
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
    const out: (ManagedPosition & { agentId: string; agentName: string })[] = [];
    for (const agent of agents) {
      for (const position of await this.positionsOf(agent)) {
        out.push({ ...position, agentId: agent.id, agentName: agent.name });
      }
    }
    return out.sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
  }

  engineRuntimeFor(agentId: string): TradingRuntime | undefined {
    return this.runtimes.get(agentId);
  }
}
