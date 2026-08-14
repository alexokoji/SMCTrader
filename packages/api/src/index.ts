import {
  DEFAULT_RISK_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  BinanceExecutionAdapter,
  MultiExchangeMarketData,
  DemoMarketData,
  type TradingMode,
} from "@smc/core";
import { ApiApp } from "./app.js";
import { connectMongo } from "./mongo.js";
import { MongoAuthService } from "./auth.js";

// Local development follows the repository's .env.example without requiring a
// runtime dotenv dependency. Deployment environments continue to use env vars.
try {
  process.loadEnvFile?.();
} catch {
  // No .env file is normal in CI and production.
}

const port = Number(process.env.PORT ?? 8787);
const startingEquity = Number(process.env.STARTING_EQUITY ?? 10000);

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;
const hasCredentials = Boolean(apiKey && apiSecret);

const mode: TradingMode =
  (process.env.MODE as TradingMode | undefined) ?? (hasCredentials ? "LIVE" : "PAPER");
const marketDataMode = process.env.MARKET_DATA_MODE ?? (process.env.NODE_ENV === "production" ? "live" : "demo");
const marketData = marketDataMode === "demo"
  ? new DemoMarketData()
  : new MultiExchangeMarketData({
      exchanges: (process.env.MARKET_DATA_EXCHANGES?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) as import("@smc/core").PublicExchange[] | undefined),
    });

const mongoUri = process.env.MONGODB_URI;
const persistence = mongoUri ? await connectMongo(mongoUri, process.env.MONGODB_DB ?? "smctrader") : undefined;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI;
if (Boolean(googleClientId) !== Boolean(googleClientSecret) || Boolean(googleClientId) !== Boolean(googleRedirectUri)) {
  throw new Error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set together.");
}
const auth = persistence ? new MongoAuthService(persistence.database, googleClientId && googleClientSecret && googleRedirectUri
  ? { clientId: googleClientId, clientSecret: googleClientSecret, redirectUri: googleRedirectUri }
  : undefined) : undefined;
await auth?.initialize();

const app = new ApiApp({
  marketData,
  strategy: DEFAULT_STRATEGY_CONFIG,
  risk: DEFAULT_RISK_CONFIG,
  startingEquity,
  mode,
  execution: hasCredentials
    ? new BinanceExecutionAdapter({ apiKey: apiKey!, apiSecret: apiSecret! })
    : undefined,
  // A smaller local demo backfill keeps interactive mode switches and state
  // broadcasts responsive while still providing enough candles for the SMC
  // engines to establish context. Live feeds retain the production default.
  feed: marketDataMode === "demo" ? { historyLimit: 120 } : true,
  exchangeConnections: persistence?.exchangeConnections,
  auth,
  authRedirectUrl: process.env.AUTH_REDIRECT_URL,
});

app.listen(port).then(() => {
  console.log(`@smc/api listening on http://localhost:${port}`);
  console.log(
    `symbol=${DEFAULT_STRATEGY_CONFIG.symbol} mode=${app.engine.getMode()} data=${marketData.name} feed=${app.feed?.getStats().running ?? false}`,
  );
  if (mode === "LIVE" && !hasCredentials) {
    console.warn("MODE=LIVE requires BINANCE_API_KEY and BINANCE_API_SECRET.");
  }
  console.log(`persistence=${persistence ? "mongodb" : "in-memory"}`);
});

async function shutdown(): Promise<void> {
  await app.close();
  await persistence?.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
