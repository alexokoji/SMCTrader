import { describe, expect, it } from "vitest";
import { explainCycle, explainSetup } from "../src/explain/explanation.js";
import { makeSetup } from "./helpers.js";

describe("explainSetup", () => {
  it("explains a VALID setup with pass lines and a validated headline", () => {
    const setup = makeSetup({
      status: "VALID",
      hardRules: [
        { name: "HTF bias", status: "PASS", detail: "Bullish higher-timeframe bias." },
        { name: "RR", status: "PASS", detail: "RR = 1:3.0 meets the minimum." },
      ],
      riskPct: 1,
      positionSize: 0.5,
    });
    const ex = explainSetup(setup);
    expect(ex.verdict).toBe("VALIDATED");
    expect(ex.headline).toContain("validated");
    expect(ex.lines.some((l) => l.label === "HTF bias" && l.ok === true)).toBe(true);
    expect(ex.lines.some((l) => l.label === "RR")).toBe(true);
    expect(ex.lines.some((l) => l.label === "Risk" && l.detail.includes("0.50000000"))).toBe(true);
    expect(ex.rejectionReasons).toEqual([]);
  });

  it("explains a REJECTED setup with the failing reason and action", () => {
    const setup = makeSetup({
      status: "REJECTED",
      hardRules: [
        { name: "HTF bias", status: "PASS", detail: "Bullish higher-timeframe bias." },
        { name: "RR", status: "FAIL", detail: "RR = 1:2.1 is below the required 1:3." },
        { name: "Entry model", status: "PASS", detail: "Entry model conditions met." },
      ],
      rejectionReasons: ["RR = 1:2.1 is below the required 1:3."],
    });
    const ex = explainSetup(setup);
    expect(ex.verdict).toBe("REJECTED");
    expect(ex.headline).toBe("Trade not placed.");
    const rr = ex.lines.find((l) => l.label === "RR");
    expect(rr?.ok).toBe(false);
    expect(ex.action).toContain("below the required 1:3");
  });

  it("marks STALE setups as invalidated", () => {
    const ex = explainSetup(makeSetup({ status: "STALE", rejectionReasons: ["Stale setup — price has moved."] }));
    expect(ex.verdict).toBe("INVALIDATED");
    expect(ex.action).toContain("Stale setup");
  });

  it("reports executed setups", () => {
    const ex = explainSetup(makeSetup({ status: "EXECUTED" }));
    expect(ex.verdict).toBe("EXECUTED");
    expect(ex.headline).toContain("Trade placed");
  });
});

describe("explainCycle", () => {
  it("counts valid and rejected setups deterministically", () => {
    const valid = makeSetup({ id: "a", status: "VALID" });
    const executed = makeSetup({ id: "b", status: "EXECUTED" });
    const rejected = makeSetup({ id: "c", status: "REJECTED", rejectionReasons: ["Daily loss limit reached."] });
    const cycle = explainCycle({
      symbol: "BTCUSDT",
      timestamp: 1234,
      engineStatus: "READY",
      message: "1 valid setup, 1 rejected.",
      setups: [valid, executed, rejected],
    });
    expect(cycle.validCount).toBe(2);
    expect(cycle.rejectedCount).toBe(1);
    expect(cycle.setups.map((s) => s.setupId)).toEqual(["a", "b", "c"]);
    expect(cycle.message).toContain("1 rejected");
  });
});