import { MongoClient, type Collection, type Db } from "mongodb";
import type { StoredExchangeConnection } from "./connections.js";

export interface MongoPersistence {
  client: MongoClient;
  database: Db;
  exchangeConnections: Collection<StoredExchangeConnection>;
  close(): Promise<void>;
}

/** Opens the platform database and ensures indexes used by credential lookups. */
export async function connectMongo(uri: string, databaseName = "smctrader"): Promise<MongoPersistence> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const database = client.db(databaseName);
  const exchangeConnections = database.collection<StoredExchangeConnection>("exchange_connections");
  await Promise.all([
    exchangeConnections.createIndex({ id: 1 }, { unique: true }),
    exchangeConnections.createIndex({ userId: 1, createdAt: -1 }),
  ]);
  return { client, database, exchangeConnections, close: () => client.close() };
}
