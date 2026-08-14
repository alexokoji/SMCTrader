interface Env {
  TRADING_SESSION: DurableObjectNamespace;
  ALLOWED_ORIGIN?: string;
}

type RuntimeMode = "ANALYSIS_ONLY" | "PAPER" | "LIVE";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers(JSON_HEADERS);
  const origin = request.headers.get("origin");
  if (origin && (!env.ALLOWED_ORIGIN || origin === env.ALLOWED_ORIGIN)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  return headers;
}

function json(request: Request, env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request, env) });
}

export class TradingSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/state" && request.method === "GET") {
      const mode = (await this.ctx.storage.get<RuntimeMode>("mode")) ?? "PAPER";
      return Response.json({ mode, updatedAt: (await this.ctx.storage.get<number>("updatedAt")) ?? Date.now() });
    }
    if (url.pathname === "/mode" && request.method === "POST") {
      const value = (await request.json().catch(() => ({}))) as { mode?: RuntimeMode };
      if (!value.mode || !["ANALYSIS_ONLY", "PAPER"].includes(value.mode)) {
        return Response.json({ error: "Only ANALYSIS_ONLY and PAPER are enabled in the Cloudflare starter." }, { status: 400 });
      }
      await this.ctx.storage.put({ mode: value.mode, updatedAt: Date.now() });
      return Response.json({ mode: value.mode });
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request, env) });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(request, env, { status: "ok", service: "smc-trader-worker", timestamp: Date.now() });

    const stub = env.TRADING_SESSION.get(env.TRADING_SESSION.idFromName("default"));
    if (url.pathname === "/api/status" && request.method === "GET") {
      const state = (await stub.fetch("https://session/state").then((response) => response.json())) as Record<string, unknown>;
      return json(request, env, { ...state, deployment: "cloudflare", liveTradingEnabled: false });
    }
    if (url.pathname === "/api/mode" && request.method === "POST") {
      const response = await stub.fetch(new Request("https://session/mode", { method: "POST", body: request.body, headers: { "content-type": "application/json" } }));
      return new Response(response.body, { status: response.status, headers: corsHeaders(request, env) });
    }
    return json(request, env, { error: "Not found" }, 404);
  },
  async scheduled(_controller: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.resolve());
  },
} satisfies ExportedHandler<Env>;
import { DurableObject } from "cloudflare:workers";
