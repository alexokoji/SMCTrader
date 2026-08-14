import { describe, expect, it } from "vitest";
import { AnalysisEngine } from "../src/strategy/analysis-engine.js";
import { StrategyEngine } from "../src/strategy/strategy-engine.js";
import { PaperExecutionAdapter } from "../src/execution/paper.js";
import { validateRiskConfig } from "../src/config/index.js";
import { PLATFORM_LIMITS } from "../src/config/platform.js";
import type { Setup } from "../src/types/setup.js";
import type { SymbolAnalysis } from "../src/strategy/analysis-engine.js";
import { testRiskConfig, testStrategyConfig, makeSetup } from "./helpers.js";

class FakeAnalysis extends AnalysisEngine {
  constructor(setups: Setup[]) {
    super("BTCUSDT", "test", testStrategyConfig());
    this.results = {
      symbol: "BTCUSDT",
      exchange: "test",
      bias: "BULLISH",
      topDown: {
        htf: { timeframe: "4H", trend: "BULLISH", strength: "STRONG" },
        mtf: { timeframe: "1H", trend: "BULLISH", strength: "STRONG" },
        ltf: { timeframe: "15M", trend: "BULLISH" },
      },
      snapshots: {} as SymbolAnalysis["snapshots"],
      setups,
      events: [],
      status: "READY",
      updatedAt: Date.now(),
    };
  }
  private results: SymbolAnalysis;
  override analyze(): SymbolAnalysis {
    return this.results;
  }
}

function engineWith(valid: number, maxTradesPerDay: number) {
  const setups = Array.from({ length: valid }, (_, n) =>
    makeSetup({
      id: `test-${n}`,
      createdAt: Date.now(),
      entry: 100,
      stopLoss: 98,
      takeProfits: [106, 110, 114],
      rr: [3, 5, 7],
      components: {
        poi: { kind: "ORDER_BLOCK", id: `ob-${n}`, top: 99.5, bottom: 98.5, strength: 0.8, status: "FRESH" },
      },
    }),
  );
  const analysis = new FakeAnalysis(setups);
  return new StrategyEngine({
    strategy: testStrategyConfig(),
    risk: validateRiskConfig(testRiskConfig({ maxTradesPerDay })),
    mode: "PAPER",
    startingEquity: 10000,
    execution: new PaperExecutionAdapter({ initialBalance: 10000 }),
    analysis,
  });
}

describe("daily trade limit ceiling (CRITICAL)", () => {
  it("executes only 15 of 20 valid setups when the user limit is 15", async () => {
    const engine = engineWith(20, 15);
    const cycle = engine.reevaluate(100);
    const executed = cycle.decisions.filter((d) => d.decision === "EXECUTE");
    expect(executed.length).toBe(15);
    expect(cycle.rejectedSetups.filter((s) => s.status === "REJECTED").length).toBe(5);
    // overflow setups must carry an explicit limit explanation
    const overflowReason = cycle.rejectedSetups
      .map((s) => s.rejectionReasons.join(" "))
      .find((r) => r.includes("daily") || r.includes("limit"));
    expect(overflowReason).toBeTruthy();
    await engine.flush();
    expect(engine.getOpenPositions().length).toBe(15);
  }, 20000);

  it("executes 15 of 20 valid setups when the user requests 20 (clamped to 15)", async () => {
    // User requested 20 -> platform clamps to 15 before anything executes.
    const risk = validateRiskConfig(testRiskConfig({ maxTradesPerDay: 20 }));
    expect(risk.maxTradesPerDay).toBe(PLATFORM_LIMITS.maxTradesPerDay);
    const engine = engineWith(20, 20);
    const cycle = engine.reevaluate(100);
    expect(cycle.decisions.filter((d) => d.decision === "EXECUTE").length).toBe(15);
    await engine.flush();
    expect(engine.getOpenPositions().length).toBe(15);
  }, 20000);

  it("clamps a requested limit above 15 and below 1 to the platform bounds", () => {
    expect(validateRiskConfig(testRiskConfig({ maxTradesPerDay: 16 })).maxTradesPerDay).toBe(15);
    expect(validateRiskConfig(testRiskConfig({ maxTradesPerDay: 0 })).maxTradesPerDay).toBe(1);
    expect(validateRiskConfig(testRiskConfig({ maxTradesPerDay: -3 })).maxTradesPerDay).toBe(1);
    expect(validateRiskConfig(testRiskConfig({ maxTradesPerDay: Number.NaN })).maxTradesPerDay).toBe(1);
  });

  it("executes exactly 15 when the limit is 15 and exactly 15 valid setups appear", async () => {
    const engine = engineWith(15, 15);
    const cycle = engine.reevaluate(100);
    const executed = cycle.decisions.filter((d) => d.decision === "EXECUTE");
    expect(executed.length).toBe(15);
    expect(cycle.rejectedSetups.length).toBe(0);
    await engine.flush();
    expect(engine.getOpenPositions().length).toBe(15);
  }, 20000);

  it("executes exactly 5 valid setups when the limit is 10 (ceiling, not quota)", async () => {
    const engine = engineWith(5, 10);
    const cycle = engine.reevaluate(100);
    expect(cycle.decisions.filter((d) => d.decision === "EXECUTE").length).toBe(5);
    await engine.flush();
    expect(engine.getOpenPositions().length).toBe(5);
    // no message about hitting a ceiling is required when below it
    expect(cycle.message).toBeUndefined();
  }, 20000);

  it("executes exactly 1 setup when the user limit is 1", async () => {
    const engine = engineWith(3, 1);
    const cycle = engine.reevaluate(100);
    expect(cycle.decisions.filter((d) => d.decision === "EXECUTE").length).toBe(1);
    await engine.flush();
    expect(engine.getOpenPositions().length).toBe(1);
  }, 20000);

  it("executes exactly 10 setups when the user limit is 10", async () => {
    const engine = engineWith(12, 10);
    const cycle = engine.reevaluate(100);
    expect(cycle.decisions.filter((d) => d.decision === "EXECUTE").length).toBe(10);
    await engine.flush();
    expect(engine.getOpenPositions().length).toBe(10);
  }, 20000);

  it("executes nothing when there are no valid setups", async () => {
    const engine = engineWith(0, 10);
    const cycle = engine.reevaluate(100);
    expect(cycle.decisions.length).toBe(0);
    expect(cycle.validSetups.length).toBe(0);
  }, 20000);

  it("does not trade once the daily limit is already used", async () => {
    const engine = engineWith(2, 1);
    engine.reevaluate(100);
    await engine.flush();
    const second = engine.reevaluate(100);
    // duplicates of the same POIs are filtered AND the daily limit is used
    expect(second.decisions.filter((d) => d.decision === "EXECUTE").length).toBe(0);
  }, 20000);
});
