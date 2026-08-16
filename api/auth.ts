import { MongoClient } from "mongodb";
import { createHmac } from "node:crypto";
import type { MongoAuthService } from "../packages/api/src/auth.js";

type VercelRequest = {
  method?: string;
  url?: string;
  query: { route?: string | string[]; code?: string; state?: string; health?: string };
  headers: { cookie?: string };
  body?: unknown;
};
type VercelResponse = {
  status(code: number): VercelResponse;
  json(value: unknown): void;
  redirect(code: number, url: string): void;
  setHeader(name: string, value: string): void;
};

declare global {
  // Reuse the client across warm Vercel invocations rather than opening a new
  // Atlas connection for every sign-in request.
  // eslint-disable-next-line no-var
  var smcMongoClientPromise: Promise<MongoClient> | undefined;
  // eslint-disable-next-line no-var
  var smcAuthPromise: Promise<MongoAuthService> | undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function auth(): Promise<MongoAuthService> {
  if (!globalThis.smcAuthPromise) {
    globalThis.smcAuthPromise = (async () => {
      const client = await (globalThis.smcMongoClientPromise ??= new MongoClient(required("MONGODB_URI"), { serverSelectionTimeoutMS: 10_000 }).connect());
      const googleClientId = process.env.GOOGLE_CLIENT_ID;
      const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI;
      if ((googleClientId || googleClientSecret || googleRedirectUri) && !(googleClientId && googleClientSecret && googleRedirectUri)) {
        throw new Error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set together.");
      }
      const google = googleClientId && googleClientSecret && googleRedirectUri
        ? { clientId: googleClientId, clientSecret: googleClientSecret, redirectUri: googleRedirectUri }
        : undefined;
      // Vercel currently emits CommonJS functions. Keep this ESM workspace
      // module dynamic so Node does not try to require() it at runtime.
      const { MongoAuthService } = await import("../packages/api/src/auth.js");
      const service = new MongoAuthService(client.db(process.env.MONGODB_DB ?? "smctrader"), google);
      await service.initialize();
      return service;
    })();
  }
  return globalThis.smcAuthPromise;
}

function token(req: VercelRequest): string | undefined {
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("smc_session="));
  return cookie ? decodeURIComponent(cookie.slice("smc_session=".length)) : undefined;
}

function cookie(value: string, remove = false): string {
  const secure = process.env.AUTH_COOKIE_SECURE === "false" ? "" : "; Secure";
  const maxAge = remove ? 0 : 60 * 60 * 24 * 14;
  return `smc_session=${remove ? "" : encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function payload(req: VercelRequest): Record<string, unknown> {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body) as Record<string, unknown>; } catch { return {}; }
  }
  return req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
}

function workerToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 5 * 60_000 })).toString("base64url");
  const signature = createHmac("sha256", required("WORKER_AUTH_SECRET")).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Vercel's Hobby plan caps a deployment at 12 serverless functions, so every
  // /api/auth/* address is rewritten onto this single function with the original
  // sub-path carried in `route` (for example "google/callback").
  const route = req.query.route;
  const routedParts = (Array.isArray(route) ? route : route ? [route] : [])
    .flatMap((part) => part.split("/"))
    .filter(Boolean);
  const parts = routedParts.length
    ? routedParts
    : new URL(req.url ?? "/", "https://vercel.local").pathname.split("/").filter(Boolean).slice(2);
  const action = parts[0];
  const method = (req.method ?? "GET").toUpperCase();
  try {
    const service = await auth();
    if (action === "session" && req.query.health === "1" && method === "GET") return res.status(200).json({ status: "ok", checks: { mongodb: "ok", authentication: "ok" }, timestamp: Date.now() });
    if ((action === "me" || action === "session") && method === "GET") return res.status(200).json({ user: await service.userForToken(token(req)) ?? null });
    if (action === "account" && (method === "GET" || method === "PATCH")) {
      const user = await service.userForToken(token(req));
      if (!user) return res.status(401).json({ error: "Sign in is required." });
      if (method === "PATCH") {
        const body = payload(req);
        const assets = Array.isArray(body.assets) && body.assets.every((asset) => typeof asset === "string") ? body.assets as string[] : undefined;
        const risk = body.risk && typeof body.risk === "object" ? body.risk as Record<string, number> : undefined;
        return res.status(200).json({ account: await service.updateTradingAccount(user.id, { assets, risk }) });
      }
      return res.status(200).json({ account: await service.getTradingAccount(user.id) });
    }
    if (action === "audit" && method === "GET") {
      const user = await service.userForToken(token(req));
      if (!user) return res.status(401).json({ error: "Sign in is required." });
      return res.status(200).json({ events: await service.listAudit(user.id) });
    }
    if (action === "paper-state" && (method === "GET" || method === "PUT")) {
      const user = await service.userForToken(token(req));
      if (!user) return res.status(401).json({ error: "Sign in is required." });
      if (method === "GET") return res.status(200).json({ state: await service.getPaperState(user.id) ?? null });
      const state = payload(req);
      if (!Array.isArray(state.positions) || !Array.isArray(state.journal) || !Array.isArray(state.activity) || !Number.isFinite(state.equity)) return res.status(400).json({ error: "Invalid paper state." });
      return res.status(200).json({ state: await service.savePaperState(user.id, { positions: state.positions, journal: state.journal, activity: state.activity, equity: state.equity as number }) });
    }
    if (action === "token" && method === "GET") {
      const user = await service.userForToken(token(req));
      if (!user) return res.status(401).json({ error: "Sign in is required." });
      return res.status(200).json({ token: workerToken(user.id), expiresIn: 300 });
    }
    if ((action === "register" || action === "login") && method === "POST") {
      const body = payload(req);
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      const name = typeof body.name === "string" ? body.name : undefined;
      const session = action === "register" ? await service.register(email, password, name) : await service.login(email, password);
      res.setHeader("Set-Cookie", cookie(session.token));
      return res.status(200).json({ user: session.user });
    }
    if (action === "logout" && method === "POST") {
      await service.logout(token(req));
      res.setHeader("Set-Cookie", cookie("", true));
      return res.status(200).json({ signedOut: true });
    }
    if (action === "google" && parts[1] !== "callback" && method === "GET") return res.redirect(302, await service.createGoogleAuthorizationUrl());
    if (action === "google" && parts[1] === "callback" && method === "GET") {
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const session = await service.loginWithGoogle(code, state);
      res.setHeader("Set-Cookie", cookie(session.token));
      return res.redirect(302, required("AUTH_REDIRECT_URL"));
    }
    return res.status(404).json({ error: "Authentication route not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authentication failed.";
    return res.status(message.includes("not configured") ? 503 : 401).json({ error: message });
  }
}
