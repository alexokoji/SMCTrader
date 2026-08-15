import { MongoClient } from "mongodb";

type ResponseLike = { status(code: number): ResponseLike; json(data: unknown): void };

declare global {
  var smcHealthMongo: Promise<MongoClient> | undefined;
}

export default async function handler(_req: unknown, res: ResponseLike): Promise<void> {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) return res.status(503).json({ status: "degraded", checks: { mongodb: "not-configured" }, timestamp: Date.now() });
    const client = await (globalThis.smcHealthMongo ??= new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 }).connect());
    await client.db(process.env.MONGODB_DB ?? "smctrader").command({ ping: 1 });
    return res.status(200).json({ status: "ok", checks: { mongodb: "ok" }, timestamp: Date.now() });
  } catch {
    return res.status(503).json({ status: "degraded", checks: { mongodb: "unavailable" }, timestamp: Date.now() });
  }
}
