import type { Candle, Timeframe } from "../types/candles.js";
import type { MarketDataProvider } from "./providers.js";

export type PublicExchange = "binance" | "bybit" | "bitget" | "okx" | "kucoin";

/**
 * Public spot-market data provider with ordered exchange failover. Each source
 * is independently normalized to the platform's candle contract, allowing the
 * analysis engine to keep running when one exchange or DNS route is down.
 */
export class MultiExchangeMarketData implements MarketDataProvider {
  readonly name = "multi-exchange";
  private readonly exchanges: PublicExchange[];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { exchanges?: PublicExchange[]; fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.exchanges = opts.exchanges?.length ? opts.exchanges : ["binance", "bybit", "bitget", "okx", "kucoin"];
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 8_000);
  }

  async getOHLCV(symbol: string, timeframe: Timeframe, startTime: number, endTime: number, limit = 1000): Promise<Candle[]> {
    return this.withFallback("candles", async (exchange) => this.candles(exchange, symbol, timeframe, startTime, endTime, limit));
  }

  async getTicker(symbol: string): Promise<{ price: number }> {
    return this.withFallback("ticker", async (exchange) => this.ticker(exchange, symbol));
  }

  async getMarkets(): Promise<string[]> {
    return this.withFallback("markets", async (exchange) => this.markets(exchange));
  }

  private async withFallback<T>(operation: string, action: (exchange: PublicExchange) => Promise<T>): Promise<T> {
    const failures: string[] = [];
    for (const exchange of this.exchanges) {
      try {
        return await action(exchange);
      } catch (err) {
        failures.push(`${exchange}: ${describeError(err)}`);
      }
    }
    throw new Error(`Public market-data ${operation} unavailable across ${this.exchanges.join(", ")}. ${failures.join("; ")}`);
  }

  private async candles(exchange: PublicExchange, symbol: string, timeframe: Timeframe, start: number, end: number, limit: number): Promise<Candle[]> {
    const url = this.candleUrl(exchange, symbol, timeframe, start, end, limit);
    const data = await this.json(url);
    const rows = exchange === "binance" ? data as unknown[][]
      : exchange === "bybit" ? (data as { result?: { list?: unknown[][] } }).result?.list ?? []
      : exchange === "bitget" ? (data as { data?: unknown[][] }).data ?? []
      : exchange === "okx" ? (data as { data?: unknown[][] }).data ?? []
      : (data as { data?: unknown[][] }).data ?? [];
    const candles = rows.map((row) => parseCandle(exchange, symbol, timeframe, row)).filter((c): c is Candle => c !== null);
    if (!candles.length) throw new Error("returned no candles");
    return candles.sort((a, b) => a.timestamp - b.timestamp);
  }

  private async ticker(exchange: PublicExchange, symbol: string): Promise<{ price: number }> {
    const data = await this.json(this.tickerUrl(exchange, symbol));
    const price = exchange === "binance" ? Number((data as { price?: string }).price)
      : exchange === "bybit" ? Number((data as { result?: { list?: Array<{ lastPrice?: string }> } }).result?.list?.[0]?.lastPrice)
      : exchange === "bitget" ? Number((data as { data?: Array<{ lastPr?: string }> }).data?.[0]?.lastPr)
      : exchange === "okx" ? Number((data as { data?: Array<{ last?: string }> }).data?.[0]?.last)
      : Number((data as { data?: { price?: string } }).data?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("returned an invalid ticker price");
    return { price };
  }

  private async markets(exchange: PublicExchange): Promise<string[]> {
    const data = await this.json(this.marketUrl(exchange));
    const symbols = exchange === "binance" ? (data as { symbols?: Array<{ symbol: string; status: string; quoteAsset: string }> }).symbols?.filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT").map((s) => s.symbol) ?? []
      : exchange === "bybit" ? (data as { result?: { list?: Array<{ symbol: string; status: string }> } }).result?.list?.filter((s) => s.status === "Trading").map((s) => s.symbol) ?? []
      : exchange === "bitget" ? (data as { data?: Array<{ symbol: string; status: string }> }).data?.filter((s) => s.status === "online").map((s) => s.symbol.replace(/USDT$/, "USDT")) ?? []
      : exchange === "okx" ? (data as { data?: Array<{ instId: string; state: string }> }).data?.filter((s) => s.state === "live").map((s) => s.instId.replace("-", "")) ?? []
      : (data as { data?: Array<{ symbol: string; enableTrading: boolean }> }).data?.filter((s) => s.enableTrading).map((s) => s.symbol.replace("-", "")) ?? [];
    if (!symbols.length) throw new Error("returned no active USDT markets");
    return symbols;
  }

  private candleUrl(exchange: PublicExchange, symbol: string, tf: Timeframe, start: number, end: number, limit: number): string {
    const pair = normalizeSymbol(exchange, symbol);
    const interval = intervalFor(exchange, tf);
    if (exchange === "binance") return `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${start}&endTime=${end}&limit=${Math.min(limit, 1000)}`;
    if (exchange === "bybit") return `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${interval}&start=${start}&end=${end}&limit=${Math.min(limit, 1000)}`;
    if (exchange === "bitget") return `https://api.bitget.com/api/v2/spot/market/candles?symbol=${pair}&granularity=${interval}&startTime=${start}&endTime=${end}&limit=${Math.min(limit, 1000)}`;
    if (exchange === "okx") return `https://www.okx.com/api/v5/market/candles?instId=${pair}&bar=${interval}&before=${end}&after=${start}&limit=${Math.min(limit, 300)}`;
    return `https://api.kucoin.com/api/v1/market/candles?symbol=${pair}&type=${interval}&startAt=${Math.floor(start / 1000)}&endAt=${Math.floor(end / 1000)}`;
  }

  private tickerUrl(exchange: PublicExchange, symbol: string): string {
    const pair = normalizeSymbol(exchange, symbol);
    if (exchange === "binance") return `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
    if (exchange === "bybit") return `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`;
    if (exchange === "bitget") return `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${pair}`;
    if (exchange === "okx") return `https://www.okx.com/api/v5/market/ticker?instId=${pair}`;
    return `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${pair}`;
  }

  private marketUrl(exchange: PublicExchange): string {
    if (exchange === "binance") return "https://api.binance.com/api/v3/exchangeInfo";
    if (exchange === "bybit") return "https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000";
    if (exchange === "bitget") return "https://api.bitget.com/api/v2/spot/public/symbols";
    if (exchange === "okx") return "https://www.okx.com/api/v5/public/instruments?instType=SPOT";
    return "https://api.kucoin.com/api/v2/symbols";
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}

function normalizeSymbol(exchange: PublicExchange, symbol: string): string {
  const clean = symbol.replace("/", "").toUpperCase();
  if (exchange === "okx" || exchange === "kucoin") return clean.replace(/(USDT|USDC|BTC|ETH)$/, "-$1");
  return clean;
}

function intervalFor(exchange: PublicExchange, tf: Timeframe): string {
  const minute = { "5M": "5", "15M": "15", "30M": "30", "1H": "60", "2H": "120", "4H": "240", "1D": "D" }[tf];
  if (exchange === "binance") return { "5M": "5m", "15M": "15m", "30M": "30m", "1H": "1h", "2H": "2h", "4H": "4h", "1D": "1d" }[tf];
  if (exchange === "bitget") return tf === "1D" ? "1day" : `${minute}min`;
  if (exchange === "okx") return tf === "1D" ? "1D" : `${minute}m`;
  if (exchange === "kucoin") return tf === "1D" ? "1day" : `${minute}min`;
  return minute;
}

function parseCandle(exchange: PublicExchange, symbol: string, timeframe: Timeframe, row: unknown[]): Candle | null {
  const values = exchange === "kucoin" ? [row[0], row[1], row[3], row[4], row[2], row[5]] : row;
  const timestamp = Number(values[0]) * (exchange === "kucoin" ? 1000 : 1);
  const open = Number(values[1]), high = Number(values[2]), low = Number(values[3]), close = Number(values[4]), volume = Number(values[5]);
  if (![timestamp, open, high, low, close, volume].every(Number.isFinite)) return null;
  return { symbol, exchange, timeframe, timestamp, open, high, low, close, volume };
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && "cause" in err ? (err as Error & { cause?: { code?: string } }).cause : undefined;
  return cause?.code === "ENOTFOUND" || /ENOTFOUND|name could not be resolved/i.test(message) ? "DNS lookup failed" : message;
}
