import { describe, expect, it } from "vitest";
import {
  PERSISTED_ACTIVITY_EVENTS,
  PERSISTED_JOURNAL_ENTRIES,
  StrategyEngine,
} from "../src/strategy/strategy-engine.js";
import { testRiskConfig, testStrategyConfig } from "./helpers.js";

/**
 * A snapshot is written to a single stored value with a hard size limit. It
 * previously carried the whole journal and activity feed, including entire
 * decision payloads, which exceeded that limit and failed the write, taking the
 * market's analysis down with it.
 */
function engineWithHistory(entries: number): StrategyEngine {
  const engine = new StrategyEngine({
    strategy: testStrategyConfig(),
    risk: testRiskConfig(),
    mode: "PAPER",
  });
  const journal = engine.getJournal();
  const activity = engine.getActivity();

  for (let i = 0; i < entries; i++) {
    journal.add({
      timestamp: i,
      symbol: "BTCUSDT",
      category: "REJECTED_SETUP",
      title: `Entry ${i}`,
      body: "x".repeat(400),
      data: {
        setupId: `s-${i}`,
        // The kind of unbounded payload that made snapshots enormous.
        decision: { reasons: Array.from({ length: 40 }, () => "a long rejection reason") },
      },
    });
    activity.add({ kind: "trade", symbol: "BTCUSDT", detail: "y".repeat(200), level: "info" });
  }
  return engine;
}

describe("persisted snapshot size", () => {
  it("keeps only a bounded tail of the journal and activity", () => {
    const snapshot = engineWithHistory(2_000).serialize();
    expect(snapshot.journal).toHaveLength(PERSISTED_JOURNAL_ENTRIES);
    expect(snapshot.activity).toHaveLength(PERSISTED_ACTIVITY_EVENTS);
  });

  it("keeps the most recent history, not the oldest", () => {
    const snapshot = engineWithHistory(500).serialize();
    // getAll returns newest first, so the newest entry must survive.
    expect(snapshot.journal[0].title).toBe("Entry 499");
  });

  it("drops payloads that have no bound but keeps the identifiers", () => {
    const [entry] = engineWithHistory(10).serialize().journal;
    expect(entry.data?.setupId).toBeDefined();
    expect(entry.data?.decision).toBeUndefined();
  });

  it("stays comfortably inside a 128KB stored value", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(engineWithHistory(5_000).serialize())).length;
    expect(bytes).toBeLessThan(128 * 1024);
  });

  it("restores from a trimmed snapshot without complaint", () => {
    const snapshot = engineWithHistory(1_000).serialize();
    const revived = new StrategyEngine({
      strategy: testStrategyConfig(),
      risk: testRiskConfig(),
      mode: "PAPER",
    });
    expect(() => revived.restore(snapshot)).not.toThrow();
    expect(revived.getJournal().getAll().length).toBe(PERSISTED_JOURNAL_ENTRIES);
  });
});
