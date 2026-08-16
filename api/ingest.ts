/**
 * Durable ingest for market history and strategy decisions.
 *
 * The Cloudflare Worker cannot reach MongoDB directly: the driver needs a TCP
 * socket that the Workers runtime does not provide. The Worker therefore signs
 * a batch with the shared worker secret and posts it here, where a normal Node
 * runtime writes it to Atlas.
 *
 * The signature covers a hash of the body, so a captured token cannot be
 * replayed against different data, and it expires.
 */
import { MongoClient } from "mongodb";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MarketPersistence, StoredAnalysisRun } from "../packages/api/src/persistence.js";

type RequestLike = { method?: string; headers: Record<string, string | undefined>; body?: unknown };
type ResponseLike = { status(code: number): ResponseLike; json(data: unknown): void };

declare global {
  // eslint-disable-next-line no-var
  var smcIngestMongo: Promise<MongoClient> | undefined;
  // eslint-disable-next-line no-var
  var smcIngestReady: Promise<MarketPersistence> | undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function hashBody(raw: string): string {
  return createHash("sha256").update(raw).digest("base64url");
}

/**
 * Verify a `<payload>.<signature>` worker token. The payload carries the body
 * hash and an expiry; both must match for the batch to be accepted.
 */
export function verifyIngestToken(
  token: string | undefined,
  secret: string,
  rawBody: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!token?.startsWith("Bearer ")) return { ok: false, reason: "Missing bearer token." };
  const [payload, signature] = token.slice(7).split(".");
  if (!payload || !signature) return { ok: false, reason: "Malformed token." };

  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = base64UrlToBuffer(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "Bad signature." };
  }

  let claims: { exp?: number; bodyHash?: string };
  try {
    claims = JSON.parse(base64UrlToBuffer(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "Unreadable token payload." };
  }
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    return { ok: false, reason: "Token expired." };
  }
  if (claims.bodyHash !== hashBody(rawBody)) {
    return { ok: false, reason: "Body does not match the signed hash." };
  }
  return { ok: true };
}

async function persistence(): Promise<MarketPersistence> {
  if (!globalThis.smcIngestReady) {
    globalThis.smcIngestReady = (async () => {
      const client = await (globalThis.smcIngestMongo ??= new MongoClient(required("MONGODB_URI"), {
        serverSelectionTimeoutMS: 10_000,
      }).connect());
      const db = client.db(process.env.MONGODB_DB ?? "smctrader");
      const store = {
        candles: db.collection("candles"),
        setupDecisions: db.collection("setup_decisions"),
        analysisRuns: db.collection("analysis_runs"),
      } as unknown as MarketPersistence;
      const { ensureMarketIndexes } = await import("../packages/api/src/persistence.js");
      await ensureMarketIndexes(store);
      return store;
    })();
  }
  return globalThis.smcIngestReady;
}

export default async function handler(req: RequestLike, res: ResponseLike): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    return void res.status(405).json({ error: "Use POST." });
  }
  try {
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const verified = verifyIngestToken(
      req.headers.authorization,
      required("WORKER_AUTH_SECRET"),
      raw,
    );
    if (!verified.ok) return void res.status(401).json({ error: verified.reason });

    const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
      userId?: string;
      candles?: unknown[];
      setups?: unknown[];
      run?: Record<string, unknown>;
    };
    if (typeof body.userId !== "string" || !body.userId) {
      return void res.status(400).json({ error: "userId is required." });
    }

    const store = await persistence();
    const { persistAnalysisRun, persistCandles, persistSetupDecisions } = await import(
      "../packages/api/src/persistence.js"
    );

    const candleResult = Array.isArray(body.candles) && body.candles.length
      ? await persistCandles(store, body.candles as never[])
      : { accepted: 0, rejected: 0 };

    const setupResult = Array.isArray(body.setups) && body.setups.length
      ? await persistSetupDecisions(store, body.userId, body.setups as never[])
      : { accepted: 0 };

    if (body.run && typeof body.run === "object") {
      await persistAnalysisRun(store, {
        ...body.run,
        userId: body.userId,
      } as unknown as StoredAnalysisRun);
    }

    return void res.status(200).json({
      candles: candleResult,
      setups: setupResult,
      run: Boolean(body.run),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingest failed.";
    return void res.status(message.includes("not configured") ? 503 : 400).json({ error: message });
  }
}
