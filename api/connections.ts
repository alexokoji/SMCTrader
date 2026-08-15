import { MongoClient } from "mongodb";
import type { MongoAuthService } from "../packages/api/src/auth.js";
import type { ConnectionVault, ConnectionInput } from "../packages/api/src/connections.js";

type RequestLike = { method?: string; headers: { cookie?: string }; body?: unknown };
type ResponseLike = { status(code: number): ResponseLike; json(data: unknown): void };

declare global {
  var smcConnectionsMongo: Promise<MongoClient> | undefined;
  var smcConnectionsAuth: Promise<MongoAuthService> | undefined;
}

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is not configured.`); return value; }
function sessionToken(req: RequestLike): string | undefined { const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("smc_session=")); return cookie ? decodeURIComponent(cookie.slice("smc_session=".length)) : undefined; }
function body(req: RequestLike): Record<string, unknown> { return req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}; }

async function auth(): Promise<{ service: MongoAuthService; client: MongoClient }> {
  const client = await (globalThis.smcConnectionsMongo ??= new MongoClient(required("MONGODB_URI"), { serverSelectionTimeoutMS: 10_000 }).connect());
  const service = await (globalThis.smcConnectionsAuth ??= (async () => {
    const { MongoAuthService } = await import("../packages/api/src/auth.js");
    const instance = new MongoAuthService(client.db(process.env.MONGODB_DB ?? "smctrader"));
    await instance.initialize();
    return instance;
  })());
  return { service, client };
}

export default async function handler(req: RequestLike, res: ResponseLike): Promise<void> {
  try {
    const { service, client } = await auth();
    const user = await service.userForToken(sessionToken(req));
    if (!user) return res.status(401).json({ error: "Sign in is required." });
    const { ConnectionVault } = await import("../packages/api/src/connections.js");
    const vault: ConnectionVault = new ConnectionVault({
      encryptionKey: required("CREDENTIAL_ENCRYPTION_KEY"),
      collection: client.db(process.env.MONGODB_DB ?? "smctrader").collection("exchange_connections"),
      userId: user.id,
    });
    await vault.hydrate();
    if (req.method === "GET") return res.status(200).json({ connections: vault.list() });
    if (req.method === "POST") {
      const input = body(req) as Partial<ConnectionInput>;
      if (input.exchange !== "binance") return res.status(400).json({ error: "Only Binance credential validation is available today. Other exchanges remain market-data only." });
      const connection = await vault.add(input as ConnectionInput);
      return res.status(201).json({ connection });
    }
    return res.status(405).json({ error: "Use GET or POST." });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Connection request failed." });
  }
}
