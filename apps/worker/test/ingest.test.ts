import { describe, expect, it, vi } from "vitest";
import type { Candle, Setup } from "@smc/core";
import { sendIngest, signIngestBody, toDecisionRecord } from "../src/ingest.js";
// The real platform-side verifier, so these tests exercise the actual boundary
// between the Worker's WebCrypto signing and Node's verification.
import { verifyIngestToken } from "../../../api/ingest.js";

const SECRET = "test-worker-secret";

function candle(timestamp: number): Candle {
  return {
    symbol: "BTCUSDT", exchange: "binance", timeframe: "1H", timestamp,
    open: 100, high: 110, low: 95, close: 105, volume: 5,
  };
}

function setup(overrides: Partial<Setup> = {}): Setup {
  return {
    id: "s-1", symbol: "BTCUSDT", exchange: "binance", direction: "LONG",
    timeframe: "15M", entryModel: "SWEEP", htfTrend: "BULLISH",
    timeframeAnalysis: {
      htf: { timeframe: "4H", trend: "BULLISH", strength: "STRONG" },
      mtf: { timeframe: "1H", trend: "BULLISH", strength: "STRONG" },
      ltf: { timeframe: "15M", trend: "BULLISH" },
    },
    entry: 100, stopLoss: 95, stopLossReason: "Below the swing low.",
    takeProfits: [110], takeProfitReasons: ["Buy-side liquidity"], rr: [2],
    riskPct: 1, score: 88, qualityFactors: [], hardRules: [], factors: [],
    reasons: ["All conditions passed."], rejectionReasons: [], status: "VALID",
    components: {}, counterTrend: false, strategyVersion: "v1", createdAt: 1_000,
    ...overrides,
  } as Setup;
}

/** Call the platform verifier the way the ingest handler does. */
function verify(token: string, body: string, now = Date.now()) {
  return verifyIngestToken(`Bearer ${token}`, SECRET, body, now);
}

describe("signIngestBody", () => {
  it("produces a token the platform verifier accepts", async () => {
    const body = JSON.stringify({ userId: "u-1", candles: [] });
    expect(verify(await signIngestBody(body, SECRET), body)).toEqual({ ok: true });
  });

  it("binds the token to the exact body, so it cannot be replayed with other data", async () => {
    const token = await signIngestBody(JSON.stringify({ userId: "u-1" }), SECRET);
    const tampered = JSON.stringify({ userId: "attacker" });
    expect(verify(token, tampered).ok).toBe(false);
    expect(verify(token, tampered).reason).toBe("Body does not match the signed hash.");
  });

  it("expires", async () => {
    const body = "{}";
    const token = await signIngestBody(body, SECRET, 1_000);
    // Signed at t=1000 with a 60s life; check well past expiry.
    expect(verify(token, body, 1_000 + 120_000).reason).toBe("Token expired.");
  });

  it("cannot be forged with the wrong secret", async () => {
    const body = "{}";
    const token = await signIngestBody(body, "wrong-secret");
    expect(verify(token, body).reason).toBe("Bad signature.");
  });
});

describe("toDecisionRecord", () => {
  it("keeps the reasoning that makes a decision auditable", () => {
    const record = toDecisionRecord(setup({ status: "REJECTED", rejectionReasons: ["RR below minimum"] }));
    expect(record.setupId).toBe("s-1");
    expect(record.status).toBe("REJECTED");
    expect(record.rejectionReasons).toEqual(["RR below minimum"]);
    expect(record.stopLossReason).toBe("Below the swing low.");
    expect(record.strategyVersion).toBe("v1");
  });
});

describe("sendIngest", () => {
  const batch = { userId: "u-1", candles: [candle(1_000)], setups: [setup()] };

  it("posts a signed batch to the platform ingest endpoint", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await sendIngest(
      { url: "https://app.example.com/", secret: SECRET, fetchFn: fetchFn as unknown as typeof fetch },
      batch,
    );

    expect(result).toEqual({ sent: true, candles: 1, setups: 1 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.example.com/api/ingest");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer .+\..+$/);
    expect(verify(headers.authorization.slice(7), init.body as string)).toEqual({ ok: true });
  });

  it("does nothing when durable storage is not configured", async () => {
    const fetchFn = vi.fn();
    const result = await sendIngest(
      { url: "", secret: "", fetchFn: fetchFn as unknown as typeof fetch },
      batch,
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/not configured/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips the request when there is nothing new to persist", async () => {
    const fetchFn = vi.fn();
    const result = await sendIngest(
      { url: "https://app.example.com", secret: SECRET, fetchFn: fetchFn as unknown as typeof fetch },
      { userId: "u-1", candles: [], setups: [] },
    );
    expect(result.sent).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports a rejected write without throwing, so trading continues", async () => {
    const fetchFn = vi.fn(async () => new Response("bad token", { status: 401 }));
    const result = await sendIngest(
      { url: "https://app.example.com", secret: SECRET, fetchFn: fetchFn as unknown as typeof fetch },
      batch,
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("401");
  });

  it("survives a network failure without throwing", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("connection reset"); });
    const result = await sendIngest(
      { url: "https://app.example.com", secret: SECRET, fetchFn: fetchFn as unknown as typeof fetch },
      batch,
    );
    expect(result).toEqual({ sent: false, reason: "connection reset", candles: 0, setups: 0 });
  });
});
