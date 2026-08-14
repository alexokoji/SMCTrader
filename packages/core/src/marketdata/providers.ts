import type { Candle, Timeframe } from "../types/candles.js";

export interface MarketDataProvider {
  readonly name: string;
  getOHLCV(
    symbol: string,
    timeframe: Timeframe,
    startTime: number,
    endTime: number,
    limit?: number,
  ): Promise<Candle[]>;
  getTicker(symbol: string): Promise<{ price: number }>;
  getMarkets(): Promise<string[]>;
}

export const BINANCE_INTERVAL: Record<Timeframe, string> = {
  "5M": "5m",
  "15M": "15m",
  "30M": "30m",
  "1H": "1h",
  "2H": "2h",
  "4H": "4h",
  "1D": "1d",
};

/**
 * Public market data provider for Binance. No API credentials required for
 * OHLCV / tickers. Used for live analysis and backtests.
 */
export class BinanceMarketData implements MarketDataProvider {
  readonly name = "binance";
  private readonly baseUrls: string[];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    /** Comma-separated endpoints are accepted to support a local proxy or mirror. */
    baseUrl?: string;
    fallbackUrls?: string[];
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {}) {
    const configured = opts.baseUrl?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
    this.baseUrls = [...new Set([
      ...configured,
      ...(opts.fallbackUrls ?? []),
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://api3.binance.com",
      "https://data-api.binance.vision",
    ].map((url) => url.replace(/\/$/, "")))];
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 12_000);
  }

  async getOHLCV(
    symbol: string,
    timeframe: Timeframe,
    startTime: number,
    endTime: number,
    limit = 1000,
  ): Promise<Candle[]> {
    const res = await this.request(`/api/v3/klines?symbol=${symbol}&interval=${BINANCE_INTERVAL[timeframe]}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`, "klines");
    const data = (await res.json()) as Array<
      [number, string, string, string, string, string]
    >;
    return data.map((k) => ({
      symbol,
      exchange: "binance",
      timeframe,
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  async getTicker(symbol: string): Promise<{ price: number }> {
    const res = await this.request(`/api/v3/ticker/price?symbol=${symbol}`, "ticker");
    const data = (await res.json()) as { symbol: string; price: string };
    return { price: parseFloat(data.price) };
  }

  async getMarkets(): Promise<string[]> {
    const res = await this.request("/api/v3/exchangeInfo", "exchangeInfo");
    const data = (await res.json()) as {
      symbols: Array<{ symbol: string; status: string; quoteAsset: string }>;
    };
    return data.symbols
      .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
      .map((s) => s.symbol);
  }

  private async request(path: string, operation: string): Promise<Response> {
    const failures: string[] = [];
    for (const baseUrl of this.baseUrls) {
      try {
        const res = await this.fetchFn(`${baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.ok) return res;
        failures.push(`${baseUrl} returned HTTP ${res.status}`);
      } catch (err) {
        failures.push(`${baseUrl}: ${networkErrorMessage(err)}`);
      }
    }
    throw new Error(
      `Binance ${operation} unavailable after ${this.baseUrls.length} endpoints. ${failures.join("; ")}. ` +
      "Check DNS/internet access or set BINANCE_REST to a reachable HTTPS market-data proxy.",
    );
  }
}

function networkErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && "cause" in err ? (err as Error & { cause?: { code?: string; message?: string } }).cause : undefined;
  if (cause?.code === "ENOTFOUND" || /ENOTFOUND|name could not be resolved/i.test(message)) {
    return "DNS lookup failed";
  }
  if (cause?.code === "ETIMEDOUT" || /timeout|timed out/i.test(message)) return "request timed out";
  return message;
}

export function assertMarketDataProvider(p: MarketDataProvider): void {
  if (!p || typeof p.getOHLCV !== "function") {
    throw new Error("Market data provider is required.");
  }
}
