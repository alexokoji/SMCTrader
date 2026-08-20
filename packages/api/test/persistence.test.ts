import { describe, expect, it } from "vitest";
import {
  MAX_CANDLES_PER_INGEST,
  ensureMarketIndexes,
  persistAnalysisRun,
  persistCandles,
  persistSetupDecisions,
  recentCandles,
  validCandle,
  type MarketPersistence,
  type StoredCandle,
} from "../src/persistence.js";

/** Records the operations issued so assertions can inspect write intent. */
function fakeCollection<T>(rows: T[] = []) {
  const bulkOps: unknown[][] = [];
  const inserted: T[][] = [];
  const indexes: { spec: Record<string, number>; options?: Record<string, unknown> }[] = [];
  return {
    bulkOps,
    inserted,
    indexes,
    rows,
    async bulkWrite(operations: unknown[]) {
      bulkOps.push(operations);
      return { ok: 1 };
    },
    async insertMany(documents: T[]) {
      inserted.push(documents);
      return { ok: 1 };
    },
    async createIndex(spec: Record<string, number>, options?: Record<string, unknown>) {
      indexes.push({ spec, options });
      return "ok";
    },
    find() {
      return {
        sort() {
          return {
            limit(n: number) {
              return { async toArray() { return rows.slice(0, n); } };
            },
          };
        },
      };
    },
  };
}

function store(rows: StoredCandle[] = []) {
  const candles = fakeCollection<StoredCandle>(rows);
  const setupDecisions = fakeCollection<never>();
  const analysisRuns = fakeCollection<never>();
  return {
    store: { candles, setupDecisions, analysisRuns } as unknown as MarketPersistence,
    candles,
    setupDecisions,
    analysisRuns,
  };
}

function candle(overrides: Partial<StoredCandle> = {}): StoredCandle {
  return {
    symbol: "BTCUSDT",
    exchange: "binance",
    timeframe: "1H",
    timestamp: 1_700_000_000_000,
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 12,
    ingestedAt: 0,
    ...overrides,
  };
}

describe("validCandle", () => {
  it("accepts a well-formed bar", () => {
    expect(validCandle(candle())).toBe(true);
  });

  it("rejects a bar whose high is below its low", () => {
    expect(validCandle(candle({ high: 90, low: 100 }))).toBe(false);
  });

  it("rejects a bar whose open or close sits outside the high/low range", () => {
    expect(validCandle(candle({ open: 200 }))).toBe(false);
    expect(validCandle(candle({ close: 1 }))).toBe(false);
  });

  it("rejects non-finite prices, which would corrupt structure calculations", () => {
    expect(validCandle(candle({ close: Number.NaN }))).toBe(false);
    expect(validCandle(candle({ volume: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it("rejects a bar missing its market identity", () => {
    expect(validCandle({ ...candle(), symbol: "" })).toBe(false);
    expect(validCandle({ ...candle(), timestamp: 0 })).toBe(false);
  });
});

describe("persistCandles", () => {
  it("upserts on the natural key so a re-sent bar does not duplicate", async () => {
    const { store: s, candles } = store();
    const result = await persistCandles(s, [candle()], 999);

    expect(result).toEqual({ accepted: 1, rejected: 0 });
    const [op] = candles.bulkOps[0] as [{ updateOne: { filter: unknown; upsert: boolean } }];
    expect(op.updateOne.upsert).toBe(true);
    expect(op.updateOne.filter).toEqual({
      symbol: "BTCUSDT",
      exchange: "binance",
      timeframe: "1H",
      timestamp: 1_700_000_000_000,
    });
  });

  it("re-states a bar that closed since it was last stored", async () => {
    const { store: s, candles } = store();
    await persistCandles(s, [candle({ close: 108, high: 112 })], 555);
    const [op] = candles.bulkOps[0] as [{ updateOne: { update: { $set: Record<string, number> } } }];
    expect(op.updateOne.update.$set.close).toBe(108);
    expect(op.updateOne.update.$set.ingestedAt).toBe(555);
  });

  it("counts malformed bars instead of writing them", async () => {
    const { store: s, candles } = store();
    const result = await persistCandles(s, [candle(), candle({ high: 1, low: 500 })]);
    expect(result).toEqual({ accepted: 1, rejected: 1 });
    expect(candles.bulkOps[0]).toHaveLength(1);
  });

  it("writes nothing at all when every bar is invalid", async () => {
    const { store: s, candles } = store();
    const result = await persistCandles(s, [candle({ close: Number.NaN })]);
    expect(result).toEqual({ accepted: 0, rejected: 1 });
    expect(candles.bulkOps).toHaveLength(0);
  });

  it("caps a single batch so one ingest cannot be unbounded", async () => {
    const { store: s, candles } = store();
    const many = Array.from({ length: MAX_CANDLES_PER_INGEST + 250 }, (_, i) =>
      candle({ timestamp: 1_700_000_000_000 + i * 3_600_000 }),
    );
    const result = await persistCandles(s, many);
    expect(result.accepted).toBe(MAX_CANDLES_PER_INGEST);
    expect(candles.bulkOps[0]).toHaveLength(MAX_CANDLES_PER_INGEST);
  });
});

describe("persistSetupDecisions", () => {
  it("keys on user and setup so one account cannot overwrite another's decision", async () => {
    const { store: s, setupDecisions } = store();
    await persistSetupDecisions(s, "user-1", [{ setupId: "s-1", symbol: "BTCUSDT", status: "REJECTED" }], 42);
    const [op] = setupDecisions.bulkOps[0] as [{ updateOne: { filter: unknown; update: Record<string, Record<string, unknown>> } }];
    expect(op.updateOne.filter).toEqual({ userId: "user-1", setupId: "s-1" });
    expect(op.updateOne.update.$set.userId).toBe("user-1");
    expect(op.updateOne.update.$set.decidedAt).toBe(42);
  });

  it("preserves the original decision time when a setup's status later changes", async () => {
    const { store: s, setupDecisions } = store();
    await persistSetupDecisions(s, "user-1", [{ setupId: "s-1", status: "EXECUTED", createdAt: 100 }], 900);
    const [op] = setupDecisions.bulkOps[0] as [{ updateOne: { update: Record<string, Record<string, unknown>> } }];
    // createdAt is only written on insert; decidedAt moves with each observation.
    expect(op.updateOne.update.$setOnInsert).toEqual({ createdAt: 100 });
    expect(op.updateOne.update.$set.status).toBe("EXECUTED");
  });

  it("never puts createdAt in both operators, which MongoDB rejects outright", async () => {
    const { store: s, setupDecisions } = store();
    await persistSetupDecisions(s, "user-1", [{ setupId: "s-1", createdAt: 100, status: "VALID" }], 900);
    const [op] = setupDecisions.bulkOps[0] as [{ updateOne: { update: Record<string, Record<string, unknown>> } }];

    // "Updating the path 'createdAt' would create a conflict at 'createdAt'"
    expect(op.updateOne.update.$set).not.toHaveProperty("createdAt");
    expect(op.updateOne.update.$setOnInsert).toEqual({ createdAt: 100 });
    const setKeys = Object.keys(op.updateOne.update.$set);
    const insertKeys = Object.keys(op.updateOne.update.$setOnInsert);
    expect(setKeys.filter((k) => insertKeys.includes(k))).toEqual([]);
  });

  it("skips entries without a setup id rather than writing junk keys", async () => {
    const { store: s, setupDecisions } = store();
    const result = await persistSetupDecisions(s, "user-1", [{ symbol: "BTCUSDT" }, { setupId: "" }]);
    expect(result.accepted).toBe(0);
    expect(setupDecisions.bulkOps).toHaveLength(0);
  });
});

describe("analysis runs and reads", () => {
  it("appends run summaries as an immutable time series", async () => {
    const { store: s, analysisRuns } = store();
    await persistAnalysisRun(s, {
      userId: "user-1", symbol: "BTCUSDT", exchange: "binance", bias: "BULLISH",
      status: "READY", warming: false, setupsSeen: 3, validSetups: 1,
      rejectedSetups: 2, executedSetups: 0, timestamp: 5,
    });
    expect(analysisRuns.inserted[0]).toHaveLength(1);
  });

  it("returns candles oldest-first for replay into the engine", async () => {
    const { store: s } = store([
      candle({ timestamp: 3_000 }),
      candle({ timestamp: 1_000 }),
      candle({ timestamp: 2_000 }),
    ]);
    const rows = await recentCandles(s, { symbol: "BTCUSDT", timeframe: "1H" });
    expect(rows.map((r) => r.timestamp)).toEqual([1_000, 2_000, 3_000]);
  });
});

describe("ensureMarketIndexes", () => {
  it("makes the candle and setup natural keys unique", async () => {
    const { store: s, candles, setupDecisions } = store();
    await ensureMarketIndexes(s);
    expect(candles.indexes[0]).toEqual({
      spec: { symbol: 1, exchange: 1, timeframe: 1, timestamp: 1 },
      options: { unique: true },
    });
    expect(setupDecisions.indexes[0]).toEqual({
      spec: { userId: 1, setupId: 1 },
      options: { unique: true },
    });
  });
});
