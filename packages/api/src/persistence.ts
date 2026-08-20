/**
 * Durable storage for market history and strategy decisions.
 *
 * The Cloudflare Worker holds candles and engine state in Durable Object
 * storage, which is fast but is scoped to a single object and can be wiped.
 * This module gives the platform a long-lived record so analytics, the audit
 * trail and the rejected-setup history survive independently of the Worker.
 *
 * Writes are idempotent: the Worker re-sends the most recent bar whenever it
 * may have closed since the last tick, and may retry after a network failure.
 */

export interface StoredCandle {
  symbol: string;
  exchange: string;
  timeframe: string;
  /** Candle open time in ms UTC. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ingestedAt: number;
}

export interface StoredSetupDecision {
  userId: string;
  setupId: string;
  symbol: string;
  exchange: string;
  direction: string;
  entryModel: string;
  timeframe: string;
  status: string;
  score: number;
  entry: number;
  stopLoss: number;
  stopLossReason?: string;
  takeProfits: number[];
  takeProfitReasons?: string[];
  rr: number[];
  counterTrend: boolean;
  hardRules: unknown[];
  factors: unknown[];
  qualityFactors: unknown[];
  reasons: string[];
  rejectionReasons: string[];
  strategyVersion: string;
  createdAt: number;
  /** When this decision was last observed, so status changes are not lost. */
  decidedAt: number;
}

export interface StoredAnalysisRun {
  userId: string;
  symbol: string;
  exchange: string;
  bias: string;
  status: string;
  warming: boolean;
  setupsSeen: number;
  validSetups: number;
  rejectedSetups: number;
  executedSetups: number;
  timestamp: number;
}

/** The subset of a MongoDB collection this module uses. */
export interface BulkCollection<T> {
  bulkWrite(operations: unknown[], options?: { ordered?: boolean }): Promise<unknown>;
  insertMany(documents: T[], options?: { ordered?: boolean }): Promise<unknown>;
  createIndex(spec: Record<string, number>, options?: Record<string, unknown>): Promise<unknown>;
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, number>): { limit(n: number): { toArray(): Promise<T[]> } };
  };
}

export interface MarketPersistence {
  candles: BulkCollection<StoredCandle>;
  setupDecisions: BulkCollection<StoredSetupDecision>;
  analysisRuns: BulkCollection<StoredAnalysisRun>;
}

/** Largest batch accepted in one ingest call, to bound memory and write time. */
export const MAX_CANDLES_PER_INGEST = 2_000;
export const MAX_SETUPS_PER_INGEST = 500;

export async function ensureMarketIndexes(store: MarketPersistence): Promise<void> {
  await Promise.all([
    // Candles are market data, not user data: one copy is shared by every account.
    store.candles.createIndex(
      { symbol: 1, exchange: 1, timeframe: 1, timestamp: 1 },
      { unique: true },
    ),
    store.candles.createIndex({ symbol: 1, timeframe: 1, timestamp: -1 }),
    store.setupDecisions.createIndex({ userId: 1, setupId: 1 }, { unique: true }),
    store.setupDecisions.createIndex({ userId: 1, createdAt: -1 }),
    store.setupDecisions.createIndex({ userId: 1, status: 1, createdAt: -1 }),
    store.analysisRuns.createIndex({ userId: 1, timestamp: -1 }),
  ]);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Reject malformed candles rather than storing them. A bad bar corrupts every
 * downstream structure calculation, and the engine explicitly must not analyse
 * incomplete data.
 */
export function validCandle(candle: Partial<StoredCandle>): boolean {
  if (!candle.symbol || !candle.exchange || !candle.timeframe) return false;
  if (!isFiniteNumber(candle.timestamp) || candle.timestamp <= 0) return false;
  for (const key of ["open", "high", "low", "close", "volume"] as const) {
    if (!isFiniteNumber(candle[key])) return false;
  }
  const { open, high, low, close } = candle as StoredCandle;
  if (high < low) return false;
  if (open > high || close > high) return false;
  if (open < low || close < low) return false;
  return true;
}

/**
 * Upsert candles by their natural key. Returns how many were accepted; invalid
 * bars are counted separately so a bad feed is visible rather than silent.
 */
export async function persistCandles(
  store: MarketPersistence,
  candles: Partial<StoredCandle>[],
  now = Date.now(),
): Promise<{ accepted: number; rejected: number }> {
  const valid = candles.filter(validCandle) as StoredCandle[];
  const rejected = candles.length - valid.length;
  if (!valid.length) return { accepted: 0, rejected };

  const operations = valid.slice(0, MAX_CANDLES_PER_INGEST).map((candle) => ({
    updateOne: {
      filter: {
        symbol: candle.symbol,
        exchange: candle.exchange,
        timeframe: candle.timeframe,
        timestamp: candle.timestamp,
      },
      update: {
        $set: {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          ingestedAt: now,
        },
      },
      upsert: true,
    },
  }));

  await store.candles.bulkWrite(operations, { ordered: false });
  return { accepted: operations.length, rejected };
}

/**
 * Upsert setup decisions by (user, setup). A setup's status changes as it moves
 * from validating to executed or rejected, so the stored row is updated rather
 * than duplicated, while `createdAt` keeps the original decision time.
 */
export async function persistSetupDecisions(
  store: MarketPersistence,
  userId: string,
  setups: Partial<StoredSetupDecision>[],
  now = Date.now(),
): Promise<{ accepted: number }> {
  const valid = setups.filter((setup) => typeof setup.setupId === "string" && setup.setupId.length > 0);
  if (!valid.length) return { accepted: 0 };

  const operations = valid.slice(0, MAX_SETUPS_PER_INGEST).map((setup) => {
    // `createdAt` cannot appear in both operators: MongoDB rejects the whole
    // update with a path conflict. The setup carries its own createdAt, so it
    // is pulled out of the $set payload and applied on insert only.
    const { createdAt, ...fields } = setup;
    return {
      updateOne: {
        filter: { userId, setupId: setup.setupId },
        update: {
          $set: { ...fields, userId, decidedAt: now },
          $setOnInsert: { createdAt: createdAt ?? now },
        },
        upsert: true,
      },
    };
  });

  await store.setupDecisions.bulkWrite(operations, { ordered: false });
  return { accepted: operations.length };
}

/** Append one analysis-run summary. These are a time series, never updated. */
export async function persistAnalysisRun(
  store: MarketPersistence,
  run: StoredAnalysisRun,
): Promise<void> {
  await store.analysisRuns.insertMany([run], { ordered: false });
}

export async function recentSetupDecisions(
  store: MarketPersistence,
  userId: string,
  limit = 200,
): Promise<StoredSetupDecision[]> {
  return store.setupDecisions
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, MAX_SETUPS_PER_INGEST))
    .toArray();
}

export async function recentCandles(
  store: MarketPersistence,
  query: { symbol: string; timeframe: string; limit?: number },
): Promise<StoredCandle[]> {
  const rows = await store.candles
    .find({ symbol: query.symbol, timeframe: query.timeframe })
    .sort({ timestamp: -1 })
    .limit(Math.min(query.limit ?? 500, MAX_CANDLES_PER_INGEST))
    .toArray();
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}
