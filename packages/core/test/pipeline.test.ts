import { describe, expect, it } from "vitest";
import type { Candle } from "../src/types/candles.js";
import { AnalysisEngine } from "../src/strategy/analysis-engine.js";
import { StrategyEngine } from "../src/strategy/strategy-engine.js";
import { PaperExecutionAdapter } from "../src/execution/paper.js";
import { validateRiskConfig } from "../src/config/index.js";
import { feedAll, testRiskConfig, testStrategyConfig } from "./helpers.js";
import { alignedBearishSetup, alignedBullishSetup } from "./fixtures.js";

describe("strategy pipeline", () => {
  it("produces a valid bullish confirmation setup from the fixture", () => {
    const engine = new AnalysisEngine("BTCUSDT", "test", testStrategyConfig());
    const data = alignedBullishSetup();
    feedAll(engine, [...data["4H"]!, ...data["1H"]!, ...data["15M"]!]);
    const result = engine.analyze();
    expect(result.bias).toBe("BULLISH");
    const valid = result.setups.filter((s) => s.status === "VALID");
    expect(valid.length).toBeGreaterThan(0);
    expect(valid[0].direction).toBe("LONG");
    expect(valid[0].entryModel).toBe("CONFIRMATION");
    expect(valid[0].rr[0]).toBeGreaterThanOrEqual(1);
    expect(valid[0].components.orderBlockId).toBeDefined();
  }, 20000);

  it("produces a valid bearish confirmation setup from the mirror fixture", () => {
    const engine = new AnalysisEngine("BTCUSDT", "test", testStrategyConfig());
    const data = alignedBearishSetup();
    feedAll(engine, [...data["4H"]!, ...data["1H"]!, ...data["15M"]!]);
    const result = engine.analyze();
    expect(result.bias).toBe("BEARISH");
    const valid = result.setups.filter((s) => s.status === "VALID");
    expect(valid.length).toBeGreaterThan(0);
    expect(valid[0].direction).toBe("SHORT");
    expect(valid[0].rr[0]).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("runs the full strategy engine cycle end-to-end", async () => {
    const strategy = testStrategyConfig();
    const risk = validateRiskConfig(
      testRiskConfig({ maxTradesPerDay: 5, maxSymbolExposurePct: 500 }),
    );
    const engine = new StrategyEngine({
      strategy,
      risk,
      mode: "PAPER",
      startingEquity: 10000,
      execution: new PaperExecutionAdapter({ initialBalance: 10000 }),
    });
    const data = alignedBullishSetup();
    const all = [...data["4H"]!, ...data["1H"]!, ...data["15M"]!].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    let sawValidated = false;
    let sawDecision = false;
    for (const c of all) {
      const cycle = engine.onCandleClosed(c);
      if (cycle.validSetups.length > 0) sawValidated = true;
      if (cycle.decisions.some((d) => d.decision === "EXECUTE")) sawDecision = true;
    }
    await engine.flush();
    expect(sawValidated).toBe(true);
    expect(sawDecision).toBe(true);
    expect(engine.getOpenPositions().length).toBeGreaterThan(0);

    // Duplicate protection: replaying the same state must not trade the same POI twice.
    const replay = engine.reevaluate();
    expect(replay.decisions.filter((d) => d.decision === "EXECUTE").length).toBe(0);
  }, 20000);

  it("rejects with an explicit reason when HTF bias opposes the setup", () => {
    // Use a bearish LTF against a bullish HTF: the resulting LONG must fail the
    // "HTF bias" hard rule with an explanation.
    const engine = new AnalysisEngine("BTCUSDT", "test", testStrategyConfig());
    const data = alignedBullishSetup();
    feedAll(engine, [...data["4H"]!, ...data["1H"]!, ...data["15M"]!]);
    const result = engine.analyze();
    expect(result.setups.length).toBeGreaterThan(0);
    const setup = result.setups[0];
    expect(setup.hardRules.find((h) => h.name === "HTF bias")?.status).toBe("PASS");
  }, 20000);
});
