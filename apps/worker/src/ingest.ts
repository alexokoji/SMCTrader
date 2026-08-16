/**
 * Ships candles and setup decisions to durable storage.
 *
 * Durable Object storage is fast but scoped and wipeable, so the record that
 * analytics and the audit trail depend on lives in MongoDB. The Worker cannot
 * open a TCP socket to Atlas, so batches are signed and posted to the platform's
 * /api/ingest endpoint.
 *
 * Persistence is strictly best-effort: a storage outage must never stop the
 * engine from analysing markets or managing open positions.
 */
import type { Candle, Setup } from "@smc/core";

export interface IngestConfig {
  /** Origin of the platform API, e.g. https://app.example.com */
  url: string;
  secret: string;
  fetchFn?: typeof fetch;
}

export interface IngestBatch {
  userId: string;
  candles: Candle[];
  setups: Setup[];
  run?: {
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
  };
}

export interface IngestResult {
  sent: boolean;
  reason?: string;
  candles: number;
  setups: number;
}

const TOKEN_TTL_MS = 60_000;

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(digest);
}

/**
 * Mint a short-lived token binding this exact body. Signing the body hash means
 * a captured token cannot be replayed to write different data.
 */
export async function signIngestBody(
  body: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({
      sub: "worker",
      exp: now + TOKEN_TTL_MS,
      bodyHash: await sha256Base64Url(body),
    })),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(signature)}`;
}

/** Strip a setup down to the fields worth keeping as a durable decision record. */
export function toDecisionRecord(setup: Setup): Record<string, unknown> {
  return {
    setupId: setup.id,
    symbol: setup.symbol,
    exchange: setup.exchange,
    direction: setup.direction,
    entryModel: setup.entryModel,
    timeframe: setup.timeframe,
    status: setup.status,
    score: setup.score,
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    stopLossReason: setup.stopLossReason,
    takeProfits: setup.takeProfits,
    takeProfitReasons: setup.takeProfitReasons,
    rr: setup.rr,
    counterTrend: setup.counterTrend,
    hardRules: setup.hardRules,
    factors: setup.factors,
    qualityFactors: setup.qualityFactors,
    reasons: setup.reasons,
    rejectionReasons: setup.rejectionReasons,
    strategyVersion: setup.strategyVersion,
    createdAt: setup.createdAt,
  };
}

export async function sendIngest(
  config: IngestConfig | undefined,
  batch: IngestBatch,
): Promise<IngestResult> {
  const candles = batch.candles.length;
  const setups = batch.setups.length;

  if (!config?.url || !config.secret) {
    return { sent: false, reason: "Durable storage is not configured.", candles: 0, setups: 0 };
  }
  if (!candles && !setups && !batch.run) {
    return { sent: false, reason: "Nothing new to persist.", candles: 0, setups: 0 };
  }

  const body = JSON.stringify({
    userId: batch.userId,
    candles: batch.candles,
    setups: batch.setups.map(toDecisionRecord),
    run: batch.run,
  });

  try {
    const token = await signIngestBody(body, config.secret);
    const doFetch = config.fetchFn ?? fetch;
    const response = await doFetch(`${config.url.replace(/\/$/, "")}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { sent: false, reason: `Ingest returned ${response.status}. ${detail}`.trim(), candles: 0, setups: 0 };
    }
    return { sent: true, candles, setups };
  } catch (error) {
    // Swallowed deliberately: trading continues regardless of storage health.
    return {
      sent: false,
      reason: error instanceof Error ? error.message : "Ingest request failed.",
      candles: 0,
      setups: 0,
    };
  }
}
