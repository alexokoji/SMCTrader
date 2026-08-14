import type { Candle, Side } from "../types/candles.js";
import { timeframeDuration } from "../types/candles.js";
import type { RiskConfig, StrategyConfig } from "../config/index.js";
import { validateRiskConfig } from "../config/index.js";
import type { ExchangeAdapter } from "../execution/types.js";
import { PaperExecutionAdapter } from "../execution/paper.js";
import { PositionManager } from "../execution/position-manager.js";
import type { TradeDecision } from "../types/contracts.js";
import type { Setup } from "../types/setup.js";
import { ActivityFeed, Journal } from "../journal/journal.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { round } from "../util.js";
import { explainCycle, type CycleExplanation } from "../explain/explanation.js";
import { AnalysisEngine } from "./analysis-engine.js";

export type TradingMode = "ANALYSIS_ONLY" | "PAPER" | "LIVE";

export interface StrategyCycleResult {
  symbol: string;
  exchange: string;
  timestamp: number;
  status: string;
  decisions: TradeDecision[];
  rejectedSetups: Setup[];
  validSetups: Setup[];
  message?: string;
  explanation: CycleExplanation;
}

export interface StrategyEngineOptions {
  strategy: StrategyConfig;
  risk: RiskConfig;
  mode: TradingMode;
  execution?: ExchangeAdapter;
  startingEquity?: number;
  /** optional pre-built analysis engine (used by tests and dashboards) */
  analysis?: AnalysisEngine;
}

export class StrategyEngine {
  readonly analysis: AnalysisEngine;
  private riskEngine: RiskEngine;
  private positionManager: PositionManager;
  private journal: Journal;
  private activity: ActivityFeed;
  private strategyCfg: StrategyConfig;
  private riskCfg: RiskConfig;
  private mode: TradingMode;
  private execution?: ExchangeAdapter;
  private executedFingerprints: Map<string, number> = new Map();
  private pendingKeys: Set<string> = new Set();
  private pendingSubmissions: Promise<void>[] = [];
  private autoTrading = true;
  private safetyBlocked = false;
  private dailyCounter: { dayKey: string; count: number } = { dayKey: "", count: 0 };
  private lastSeenTs = 0;

  constructor(opts: StrategyEngineOptions) {
    this.strategyCfg = opts.strategy;
    this.riskCfg = validateRiskConfig(opts.risk);
    this.mode = opts.mode;
    this.execution = opts.execution ?? (opts.mode === "PAPER" ? new PaperExecutionAdapter({
      initialBalance: opts.startingEquity ?? 10000,
      feePct: this.riskCfg.feePct,
      slippagePct: this.riskCfg.slippagePct,
    }) : undefined);
    this.analysis = opts.analysis ?? new AnalysisEngine(
      opts.strategy.symbol,
      opts.strategy.exchange,
      opts.strategy,
    );
    this.riskEngine = new RiskEngine(this.riskCfg, {
      equity: opts.startingEquity ?? 10000,
      equityDayStart: opts.startingEquity ?? 10000,
      peakEquity: opts.startingEquity ?? 10000,
    });
    this.positionManager = new PositionManager({
      feePct: this.riskCfg.feePct,
      slippagePct: this.riskCfg.slippagePct,
      breakEvenOnTp1: this.strategyCfg.breakEvenOnTp1,
      partialPlan: this.strategyCfg.partialClosePlan,
    });
    this.journal = new Journal();
    this.activity = new ActivityFeed();
  }

  getJournal(): Journal {
    return this.journal;
  }

  getActivity(): ActivityFeed {
    return this.activity;
  }

  getPositions(): ReturnType<PositionManager["getAll"]> {
    return this.positionManager.getAll();
  }

  getOpenPositions(): ReturnType<PositionManager["getOpenPositions"]> {
    return this.positionManager.getOpenPositions();
  }

  getRiskState() {
    return this.riskEngine.getState();
  }

  get riskLimits() {
    return this.riskCfg;
  }

  get strategyConfig(): StrategyConfig {
    return { ...this.strategyCfg };
  }

  /**
   * Apply a new validated+clamped risk configuration at runtime. Equity and
   * daily counters are preserved; only the limit/sizing parameters change.
   */
  updateRiskConfig(cfg: RiskConfig): void {
    const next = validateRiskConfig(cfg);
    const state = this.riskEngine.getState();
    this.riskCfg = next;
    this.riskEngine = new RiskEngine(next, {
      equity: state.equity,
      equityDayStart: state.equityDayStart,
      peakEquity: state.peakEquity,
      tradesToday: state.tradesToday,
      realizedPnlToday: state.realizedPnlToday,
      openPositions: state.openPositions,
      usedExposure: state.usedExposure,
      usedCorrelatedExposure: state.usedCorrelatedExposure,
      dailyLossReached: state.dailyLossReached,
      drawdownReached: state.drawdownReached,
    });
    this.positionManager.updateOptions({
      breakEvenOnTp1: this.strategyCfg.breakEvenOnTp1,
      partialPlan: this.strategyCfg.partialClosePlan,
    });
    this.activity.add({
      kind: "config",
      symbol: this.strategyCfg.symbol,
      detail: `Risk configuration updated: ${next.maxTradesPerDay} trades/day max, ${next.riskPerTrade}% risk/trade, ${next.maxDailyLossPct}% daily loss, ${next.maxDrawdownPct}% drawdown.`,
      level: "info",
    });
  }

  /**
   * Apply a new strategy configuration at runtime. Structural fields
   * (symbol, exchange, timeframes, swing detection) are rejected by the
   * analysis engine; other settings take effect immediately.
   */
  updateStrategyConfig(cfg: StrategyConfig): void {
    this.analysis.updateConfig(cfg);
    this.strategyCfg = cfg;
    this.positionManager.updateOptions({
      breakEvenOnTp1: cfg.breakEvenOnTp1,
      partialPlan: cfg.partialClosePlan,
    });
    this.activity.add({
      kind: "config",
      symbol: cfg.symbol,
      detail: `Strategy configuration updated: ${cfg.name} (${cfg.version}).`,
      level: "info",
    });
  }

  setMode(mode: TradingMode): void {
    this.mode = mode;
    this.activity.add({
      kind: "mode",
      symbol: this.strategyCfg.symbol,
      detail: `Trading mode set to ${mode}.`,
      level: "info",
    });
  }

  getMode(): TradingMode {
    return this.mode;
  }

  setExecution(execution?: ExchangeAdapter): void {
    this.execution = execution;
    if (execution) {
      this.activity.add({
        kind: "exchange",
        symbol: this.strategyCfg.symbol,
        detail: `Execution adapter connected: ${execution.name}.`,
        level: "success",
      });
    }
  }

  setAutoTrading(enabled: boolean): void {
    this.autoTrading = enabled;
    this.activity.add({
      kind: "autotrading",
      symbol: this.strategyCfg.symbol,
      detail: enabled ? "Auto trading ENABLED." : "Auto trading STOPPED — no new trades will be opened.",
      level: enabled ? "success" : "danger",
    });
  }

  isAutoTrading(): boolean {
    return this.autoTrading;
  }

  /** Emergency safe mode: halts new trades until explicitly lifted. */
  enterSafeMode(reason: string): void {
    this.safetyBlocked = true;
    this.activity.add({
      kind: "safemode",
      symbol: this.strategyCfg.symbol,
      detail: `SAFE MODE: ${reason}`,
      level: "danger",
    });
    this.journal.add({
      timestamp: Date.now(),
      symbol: this.strategyCfg.symbol,
      category: "SYSTEM_EVENT",
      title: "Safe mode entered",
      body: reason,
    });
  }

  exitSafeMode(): void {
    this.safetyBlocked = false;
    this.activity.add({
      kind: "safemode",
      symbol: this.strategyCfg.symbol,
      detail: "Safe mode cleared. New trades allowed again.",
      level: "success",
    });
  }

  isSafetyBlocked(): boolean {
    return this.safetyBlocked;
  }

  /** Feed a closed candle and run the full decision pipeline. */
  onCandleClosed(candle: Candle): StrategyCycleResult {
    if (candle.timestamp > this.lastSeenTs) this.lastSeenTs = candle.timestamp;
    this.analysis.onCandleClosed(candle);
    const analysis = this.analysis.analyze();
    return this.processCycle(analysis);
  }

  /** Re-run the decision pipeline on the current state (used for price-only ticks). */
  reevaluate(price?: number): StrategyCycleResult {
    const analysis = this.analysis.analyze();
    return this.processCycle(analysis, price);
  }

  private processCycle(
    analysis: ReturnType<AnalysisEngine["analyze"]>,
    currentPrice?: number,
  ): StrategyCycleResult {
    const now = analysis.updatedAt;
    const symbol = analysis.symbol;
    const decisions: TradeDecision[] = [];
    const rejectedSetups: Setup[] = [];
    const validSetups: Setup[] = [];

    const allValid = analysis.setups.filter((s) => s.status === "VALID");
    const remaining = this.remainingTradesToday();
    this.pendingKeys.clear();

    const eligible: { setup: Setup; rejectReason?: string }[] = [];

    for (const setup of allValid) {
      // 1. Duplicate protection (including setups already chosen this cycle)
      const dup = this.isDuplicate(setup);
      if (dup) {
        setup.status = "INVALIDATED";
        setup.rejectionReasons = ["Duplicate setup — this setup was already executed or is already active."];
        rejectedSetups.push(setup);
        this.journal.add({
          timestamp: now,
          symbol,
          category: "REJECTED_SETUP",
          title: "Duplicate setup blocked",
          body: `${setup.direction} ${setup.entryModel} at ${round(setup.entry, 4)} rejected: identical setup already handled.`,
          data: { setupId: setup.id },
        });
        continue;
      }

      // 2. Stale setup protection
      const stale = this.isStale(setup, currentPrice);
      if (stale) {
        setup.status = "STALE";
        setup.rejectionReasons = ["Stale setup — price has moved or the setup exceeded its validity window."];
        rejectedSetups.push(setup);
        this.journal.add({
          timestamp: now,
          symbol,
          category: "REJECTED_SETUP",
          title: "Stale setup invalidated",
          body: stale,
          data: { setupId: setup.id },
        });
        continue;
      }

      validSetups.push(setup);
      eligible.push({ setup });
    }

    // 3. Deterministic prioritization (score desc, alignment desc, then time)
    eligible.sort((a, b) => {
      if (b.setup.score !== a.setup.score) return b.setup.score - a.setup.score;
      const alignA = a.setup.components.chochEvent ? 1 : 0;
      const alignB = b.setup.components.chochEvent ? 1 : 0;
      if (alignB !== alignA) return alignB - alignA;
      return a.setup.createdAt - b.setup.createdAt;
    });

    // 4. Daily trade limit ceiling (not a quota)
    const takeCount = Math.max(0, Math.min(eligible.length, remaining));
    const capped = eligible.slice(0, takeCount);
    const overflow = eligible.slice(takeCount);

    let message: string | undefined;
    if (eligible.length > takeCount) {
      message = `${eligible.length} valid setups found. User daily limit: ${this.riskCfg.maxTradesPerDay} (${this.usedToday()} used). The ${takeCount} highest-priority setups were eligible for execution.`;
    } else if (eligible.length > 0 && takeCount === 0) {
      message = `${eligible.length} valid setups found but the daily trade limit has been reached.`;
    }
    if (eligible.length === 0) {
      message = `No valid setups this cycle. Trade count is never forced; the limit is a ceiling, not a target.`;
    }

    for (const overflowSetup of overflow) {
      overflowSetup.setup.status = "REJECTED";
      overflowSetup.setup.rejectionReasons = [
        `Daily trade limit reached (${this.riskCfg.maxTradesPerDay}). This setup was valid but exceeded the configured daily ceiling.`,
      ];
      rejectedSetups.push(overflowSetup.setup);
      this.journal.add({
        timestamp: now,
        symbol,
        category: "REJECTED_SETUP",
        title: "Valid setup not traded — daily ceiling",
        body: `${overflowSetup.setup.direction} setup with score ${overflowSetup.setup.score} was valid but the daily trade limit of ${this.riskCfg.maxTradesPerDay} was already used.`,
        data: { setupId: overflowSetup.setup.id },
      });
    }

    // 5. Risk check + execution for each eligible candidate
    for (const { setup } of capped) {
      this.pendingKeys.add(this.fingerprintOf(setup));
      const decision = this.decideAndExecute(setup, now, currentPrice);
      decisions.push(decision);
    }

    const status = this.computeEngineStatus(decisions, eligible.length, takeCount);
    const allSetups = [...validSetups, ...rejectedSetups];
    const uniqueSetups = allSetups.filter(
      (s, i) => allSetups.findIndex((x) => x.id === s.id) === i,
    );
    return {
      symbol,
      exchange: this.strategyCfg.exchange,
      timestamp: now,
      status,
      decisions,
      rejectedSetups,
      validSetups,
      message,
      explanation: explainCycle({
        symbol,
        timestamp: now,
        engineStatus: status,
        message,
        setups: uniqueSetups,
      }),
    };
  }

  private decideAndExecute(
    setup: Setup,
    now: number,
    currentPrice?: number,
  ): TradeDecision {
    const symbol = this.strategyCfg.symbol;
    const long = setup.direction === "LONG";

    // Preflight: safety
    if (this.safetyBlocked) {
      setup.status = "REJECTED";
      setup.rejectionReasons = ["System is in safe mode."];
      return this.reject(setup, ["System is in safe mode."]);
    }
    if (!this.autoTrading) {
      setup.status = "REJECTED";
      setup.rejectionReasons = ["Auto trading is disabled. No new orders."];
      return this.reject(setup, ["Auto trading is disabled. No new orders."]);
    }

    // Risk engine decision
    const group = this.riskCfg.correlationGroups[setup.symbol] ?? "uncorrelated";
    const riskDecision = this.riskEngine.decide({
      symbol,
      direction: setup.direction,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfits: setup.takeProfits,
      minRr: this.minRrFor(setup),
      leverage: this.riskCfg.maxLeverage,
      minQuantity: 0.0001,
      stepSize: 0.0001,
      correlationGroup: group,
    });

    if (!riskDecision.allowed) {
      setup.status = "REJECTED";
      setup.rejectionReasons = riskDecision.reasons.map((r) => r.message);
      setup.riskPct = this.riskCfg.riskPerTrade;
      const kind = riskDecision.reasons[0]?.kind;
      const jCategory =
        kind === "DAILY_TRADE_LIMIT"
          ? "RISK_EVENT"
          : kind === "DAILY_LOSS_LIMIT" || kind === "MAX_DRAWDOWN"
            ? "RISK_EVENT"
            : "RISK_EVENT";
      this.journal.add({
        timestamp: now,
        symbol,
        category: jCategory,
        title: "Setup rejected by risk engine",
        body: setup.rejectionReasons.join(" "),
        data: { setupId: setup.id },
      });
      if (kind === "DAILY_LOSS_LIMIT") {
        this.activity.add({
          kind: "risk",
          symbol,
          detail: "Daily loss limit reached — no new positions until reset.",
          level: "danger",
        });
      }
      return this.reject(setup, setup.rejectionReasons);
    }

    const sizing = riskDecision.sizing!;
    setup.riskPct = this.riskCfg.riskPerTrade;
    setup.positionSize = sizing.positionSize;

    // Preflight for order safety
    const price = currentPrice ?? this.lastPrice();
    if (price === undefined) {
      return this.reject(setup, ["No current price available."]);
    }
    const preflight = this.preflight(setup, price, sizing.positionSize);
    if (!preflight.ok) {
      const reason = preflight.reason ?? "Preflight failed";
      setup.status = "REJECTED";
      setup.rejectionReasons = [reason];
      this.journal.add({
        timestamp: now,
        symbol,
        category: "ORDER",
        title: "Preflight failed",
        body: reason,
        data: { setupId: setup.id },
      });
      return this.reject(setup, [reason]);
    }

    const side: Side = long ? "BUY" : "SELL";
    const decision: TradeDecision = {
      decision: "EXECUTE",
      symbol,
      exchange: this.strategyCfg.exchange,
      side,
      orderType: "LIMIT",
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfits: setup.takeProfits,
      quantity: sizing.positionSize,
      riskAmount: sizing.riskAmount,
      rr: setup.rr,
      setupId: setup.id,
      strategyVersion: setup.strategyVersion,
      entryModel: setup.entryModel,
    };

    void this.pendingSubmissions.push(this.submitOrder(decision, setup, now));
    this.recordFingerprint(setup);
    return decision;
  }

  /**
   * Await any in-flight order submissions (used by the backtest replay loop so
   * positions open before the next bar is processed).
   */
  async flush(): Promise<void> {
    const pending = this.pendingSubmissions;
    this.pendingSubmissions = [];
    await Promise.all(pending);
  }

  private async submitOrder(
    decision: TradeDecision,
    setup: Setup,
    now: number,
  ): Promise<void> {
    if (decision.decision !== "EXECUTE") return;

    // Analysis-only: never send orders; report the validated setup.
    if (this.mode === "ANALYSIS_ONLY") {
      setup.status = "VALID";
      setup.reasons = [...(setup.reasons ?? []), "Analysis-only mode — setup validated, no order submitted."];
      this.journal.add({
        timestamp: now,
        symbol: setup.symbol,
        category: "SYSTEM_EVENT",
        title: "Setup validated (analysis only)",
        body: `${setup.direction} ${setup.entryModel} validated with score ${setup.score}. No order submitted in analysis-only mode.`,
        data: { setupId: setup.id },
      });
      return;
    }

    if (!this.execution) {
      // Paper mode works out of the box with a simulated adapter.
      if (this.mode === "PAPER") {
        this.execution = new PaperExecutionAdapter({
          initialBalance: this.riskEngine.getState().equity,
          feePct: this.riskCfg.feePct,
          slippagePct: this.riskCfg.slippagePct,
        });
        this.activity.add({
          kind: "exchange",
          symbol: setup.symbol,
          detail: "Paper execution adapter initialised.",
          level: "success",
        });
      } else {
        setup.status = "REJECTED";
        setup.rejectionReasons = ["Exchange not connected. Connect an exchange to trade."];
        return;
      }
    }
    try {
      const result = await this.execution.placeOrder({
        symbol: decision.symbol,
        side: decision.side,
        orderType: decision.orderType,
        quantity: decision.quantity,
        price: decision.entry,
        stopLoss: decision.stopLoss,
        takeProfits: decision.takeProfits,
      });
      if (result.status === "FILLED") {
        setup.status = "EXECUTED";
        const notional = result.filledQuantity * result.filledPrice;
        const group = this.riskCfg.correlationGroups[setup.symbol] ?? "uncorrelated";
        this.riskEngine.onTradeExecuted(notional, group);
        this.bumpDailyCounter(now);
        const pos = this.positionManager.openPosition({
          symbol: setup.symbol,
          exchange: this.strategyCfg.exchange,
          direction: setup.direction,
          setupId: setup.id,
          strategyVersion: setup.strategyVersion,
          entry: result.filledPrice,
          positionSize: result.filledQuantity,
          notional,
          stopLoss: decision.stopLoss,
          takeProfits: decision.takeProfits,
          openedAt: now + timeframeDuration(this.strategyCfg.timeframes.ltf),
        });
        this.journal.add({
          timestamp: now,
          symbol: setup.symbol,
          category: "TRADE",
          title: `${setup.direction} trade opened`,
          body: this.describeSetup(setup, result.filledPrice),
          data: { setupId: setup.id, orderId: result.orderId, positionId: pos.id, decision },
        });
        this.activity.add({
          kind: "trade",
          symbol: setup.symbol,
          detail: `${setup.direction} ${setup.entryModel} order filled at ${result.filledPrice.toFixed(2)}. Position ${pos.id}.`,
          level: "success",
        });
      } else {
        setup.status = "REJECTED";
        setup.rejectionReasons = [`Order failed: ${result.rejectionReason ?? "rejected by exchange"}`];
        this.journal.add({
          timestamp: now,
          symbol: setup.symbol,
          category: "ORDER",
          title: "Order failed",
          body: result.rejectionReason ?? "Exchange rejected the order.",
          data: { setupId: setup.id },
        });
      }
    } catch (err) {
      setup.status = "REJECTED";
      setup.rejectionReasons = [`Order error: ${err instanceof Error ? err.message : String(err)}`];
      this.journal.add({
        timestamp: now,
        symbol: setup.symbol,
        category: "ERROR",
        title: "Order error",
        body: err instanceof Error ? err.message : String(err),
        data: { setupId: setup.id },
      });
    }
  }

  /** Preflight safety checks immediately before submission (section 97). */
  private preflight(
    setup: Setup,
    price: number,
    quantity: number,
  ): { ok: boolean; reason?: string } {
    const checks: Array<[string, boolean, string]> = [
      ["Exchange connected", !!this.execution, "Exchange is not connected."],
      ["Market data available", price > 0, "No current market price."],
      ["Price current", Math.abs(price - setup.entry) / setup.entry <= 0.03, `Current price ${price.toFixed(2)} is too far from the setup entry ${setup.entry.toFixed(2)}.`],
      ["Setup still valid", setup.status === "VALID" || setup.status === "VALIDATING", "Setup is no longer valid."],
      ["Risk approved", setup.riskPct > 0, "Risk parameters were not approved."],
      ["Quantity valid", quantity > 0, "Position quantity is zero or negative."],
      ["Stop loss valid", setup.stopLoss > 0 && Math.abs(setup.stopLoss - setup.entry) > 0, "Stop loss is not structurally valid."],
      ["Take profits valid", setup.takeProfits.length > 0 && setup.takeProfits[0] > 0, "No valid take-profit targets."],
      ["RR valid", (setup.rr[0] ?? 0) >= this.minRrFor(setup), "Projected RR is below the configured minimum."],
    ];
    for (const [, ok, reason] of checks) {
      if (!ok) return { ok: false, reason };
    }
    return { ok: true };
  }

  private minRrFor(setup: Setup): number {
    return setup.counterTrend
      ? this.strategyCfg.minRr * this.strategyCfg.counterTrendMinRrMultiplier
      : this.strategyCfg.minRr;
  }

  private isDuplicate(setup: Setup): boolean {
    const key = this.fingerprintOf(setup);
    if (this.pendingKeys.has(key)) return true;
    const last = this.executedFingerprints.get(key);
    if (last !== undefined) {
      return true;
    }
    // also block if the same POI is already open as a position
    return this.positionManager
      .getOpenPositions()
      .some((p) => p.symbol === setup.symbol && p.direction === setup.direction && p.setupId !== setup.id);
  }

  private fingerprintOf(setup: Setup): string {
    return `${setup.symbol}:${setup.direction}:${setup.entryModel}:${setup.components.poi?.id}`;
  }

  private isStale(setup: Setup, currentPrice?: number): string | null {
    const price = currentPrice ?? this.lastPrice();
    if (setup.createdAt > 0 && this.nowMs() - setup.createdAt > this.strategyCfg.setupMaxAgeMs) {
      return "Setup exceeded its maximum validity window.";
    }
    if (price !== undefined) {
      const drift = Math.abs(price - setup.entry) / setup.entry;
      if (drift > 0.04) {
        return `Price moved ${(drift * 100).toFixed(1)}% away from the setup entry - the original entry is no longer valid.`;
      }
    }
    return null;
  }

  private lastPrice(): number | undefined {
    const ltf = this.strategyCfg.timeframes.ltf;
    const buf = this.analysis.candlesFor(ltf);
    const last = buf[buf.length - 1];
    return last?.close;
  }

  private nowMs(): number {
    return this.lastSeenTs > 0 ? this.lastSeenTs : Date.now();
  }

  private recordFingerprint(setup: Setup): void {
    this.executedFingerprints.set(this.fingerprintOf(setup), Date.now());
  }

  private describeSetup(setup: Setup, price: number): string {
    return [
      `${setup.direction} ${setup.entryModel} executed at ${price.toFixed(2)}.`,
      `Stop loss ${setup.stopLoss.toFixed(2)} (${setup.stopLossReason})`,
      `Take profits: ${setup.takeProfits.map((t, i) => `TP${i + 1}=${t.toFixed(2)}`).join(", ")}.`,
      `RR: ${setup.rr.map((r) => `1:${r.toFixed(1)}`).join(" / ")}.`,
      `Setup score: ${setup.score}/100.`,
      `Strategy version: ${setup.strategyVersion}.`,
    ].join(" ");
  }

  private reject(setup: Setup, reasons: string[]): TradeDecision {
    return { decision: "REJECT", setupId: setup.id, reasons };
  }

  private computeEngineStatus(
    decisions: TradeDecision[],
    validCount: number,
    taken: number,
  ): string {
    if (this.safetyBlocked) return "SAFE_MODE";
    if (decisions.some((d) => d.decision === "EXECUTE")) return "ORDER_SUBMITTED";
    if (taken === 0 && validCount > 0) return "DAILY_LIMIT_REACHED";
    if (validCount > 0) return "READY";
    return "SCANNING";
  }

  // ------------------------------------------------------------------
  // Daily counters (independent of wall-clock day; reset by caller)
  // ------------------------------------------------------------------

  private usedToday(): number {
    return this.riskEngine.getState().tradesToday;
  }

  private remainingTradesToday(): number {
    return this.riskEngine.getRemainingTradesToday();
  }

  private bumpDailyCounter(ts: number): void {
    const day = new Date(ts).toISOString().slice(0, 10);
    if (this.dailyCounter.dayKey !== day) {
      this.dailyCounter = { dayKey: day, count: 0 };
    }
    this.dailyCounter.count += 1;
  }

  /** Advance the trading day (called by the scheduler at midnight). */
  rolloverDay(now: number): void {
    this.riskEngine.rolloverDay();
    this.bumpDailyCounter(now);
    this.activity.add({
      kind: "risk",
      symbol: this.strategyCfg.symbol,
      detail: "Trading day rolled over. Daily loss/trade limits reset.",
      level: "info",
    });
    this.journal.add({
      timestamp: now,
      symbol: this.strategyCfg.symbol,
      category: "SYSTEM_EVENT",
      title: "Daily rollover",
      body: "New trading day. Daily loss and trade counters reset.",
    });
  }

  /** Record a price tick so open positions are managed. */
  onPriceTick(symbol: string, price: number, timestamp: number): void {
    if (timestamp > this.lastSeenTs) this.lastSeenTs = timestamp;
    this.handlePositionEvents(
      symbol,
      this.positionManager.onPrice(symbol, price, timestamp),
      timestamp,
    );
  }

  /** Record a full bar so open positions are managed with intrabar precision. */
  onPriceBar(symbol: string, bar: { high: number; low: number; close: number }, timestamp: number): void {
    if (timestamp > this.lastSeenTs) this.lastSeenTs = timestamp;
    this.handlePositionEvents(
      symbol,
      this.positionManager.onBar(symbol, bar, timestamp),
      timestamp,
    );
  }

  private handlePositionEvents(symbol: string, events: ReturnType<PositionManager["onBar"]>, timestamp: number): void {
    for (const ev of events) {
      this.activity.add({
        kind: "position",
        symbol,
        detail: ev.detail,
        level: ev.type === "STOP_LOSS_HIT" || ev.type === "CLOSED" ? (ev.realizedPnl !== undefined && ev.realizedPnl < 0 ? "danger" : "success") : "info",
      });
      if (ev.type === "STOP_LOSS_HIT" || ev.type === "CLOSED") {
        this.journal.add({
          timestamp,
          symbol,
          category: "TRADE",
          title: ev.type,
          body: ev.detail,
        });
      }
      if (ev.type === "CLOSED" && ev.realizedPnl !== undefined) {
        const closed = this.positionManager
          .getAll()
          .find((p) => p.id === ev.positionId);
        if (closed) {
          this.riskEngine.onPositionClosed(ev.realizedPnl, closed.notional, this.riskCfg.correlationGroups[symbol] ?? "uncorrelated");
        }
      }
    }
  }

  /** Close a position fully and update risk state. */
  async closePosition(positionId: string, price: number, timestamp: number): Promise<void> {
    const pos = this.positionManager.getAll().find((p) => p.id === positionId);
    if (!pos) return;
    if (this.execution && this.mode !== "ANALYSIS_ONLY") {
      await this.execution.closePosition(pos.symbol, pos.direction === "LONG" ? "BUY" : "SELL", pos.quantityRemaining);
    }
    const pnl = pos.realizedPnl;
    this.positionManager.onPrice(pos.symbol, price, timestamp);
    this.riskEngine.onPositionClosed(pnl, pos.notional, this.riskCfg.correlationGroups[pos.symbol] ?? "uncorrelated");
    this.activity.add({
      kind: "position",
      symbol: pos.symbol,
      detail: `Position ${positionId} closed at ${price.toFixed(2)}.`,
      level: pnl >= 0 ? "success" : "danger",
    });
  }
}
