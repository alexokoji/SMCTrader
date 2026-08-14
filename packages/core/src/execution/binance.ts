import { createHmac } from "node:crypto";
import type { Candle, Side, Timeframe } from "../types/candles.js";
import { BINANCE_INTERVAL } from "../marketdata/providers.js";
import type {
  AccountPermissions,
  Balance,
  ConnectionStatus,
  ExchangeAdapter,
  OrderRequest,
  OrderResult,
  TradingRules,
} from "./types.js";

export interface BinanceExecutionAdapterOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

interface BinanceBalance {
  asset: string;
  free: string;
  locked: string;
}

interface BinanceAccount {
  balances: BinanceBalance[];
}

interface BinanceSymbolFilter {
  filterType: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minNotional?: string;
  tickSize?: string;
}

interface BinanceSymbolInfo {
  symbol: string;
  status: string;
  quoteAsset: string;
  filters: BinanceSymbolFilter[];
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
}

interface BinanceOrderResult {
  orderId: number;
  symbol: string;
  side: string;
  status: string;
  executedQty: string;
  price: string;
  cummulativeQuoteQty: string;
}

/**
 * Live execution adapter for the Binance spot API. All private endpoints are
 * authenticated with HMAC-SHA256 signatures. Public endpoints need no
 * credentials. Pass `fetchFn` in tests to avoid real network calls.
 */
export class BinanceExecutionAdapter implements ExchangeAdapter {
  readonly name = "binance";
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: BinanceExecutionAdapterOptions) {
    if (!opts.apiKey || !opts.apiSecret) {
      throw new Error("BinanceExecutionAdapter requires apiKey and apiSecret");
    }
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.baseUrl = opts.baseUrl ?? "https://api.binance.com";
    this.fetchFn = opts.fetchFn ?? (async (...args) => fetch(...args));
  }

  async connect(): Promise<ConnectionStatus> {
    try {
      await this.publicRequest("/api/v3/time");
      return { connected: true, message: "Binance reachable" };
    } catch (err) {
      return { connected: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async validateCredentials(): Promise<{ valid: boolean; permissions: AccountPermissions }> {
    const account = await this.signedRequest<BinanceAccount>("/api/v3/account");
    return {
      valid: Array.isArray(account.balances),
      permissions: { tradingEnabled: true, withdrawalEnabled: true },
    };
  }

  async getAccountBalance(): Promise<Balance> {
    const account = await this.signedRequest<BinanceAccount>("/api/v3/account");
    let totalEquity = 0;
    let available = 0;
    for (const b of account.balances) {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      const total = free + locked;
      if (total <= 0) continue;
      if (b.asset === "USDT") {
        totalEquity += total;
        available += free;
      } else {
        try {
          const { price } = await this.getTicker(`${b.asset}USDT`);
          totalEquity += total * price;
          available += free * price;
        } catch {
          // Non-tradeable asset (e.g. locked staking); skip its valuation.
        }
      }
    }
    return { totalEquity, available, unrealizedPnl: 0 };
  }

  async getAvailableBalance(): Promise<number> {
    const b = await this.getAccountBalance();
    return b.available;
  }

  async getMarkets(): Promise<string[]> {
    const info = await this.publicRequest<{ symbols: BinanceSymbolInfo[] }>("/api/v3/exchangeInfo");
    return info.symbols
      .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
      .map((s) => s.symbol);
  }

  async getTicker(symbol: string): Promise<{ price: number }> {
    const data = await this.publicRequest<{ price: string }>(
      `/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
    );
    return { price: parseFloat(data.price) };
  }

  async getOHLCV(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const data = await this.publicRequest<Array<[number, string, string, string, string, string]>>(
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${BINANCE_INTERVAL[timeframe]}&limit=${limit}`,
    );
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

  async getTradingRules(symbol: string): Promise<TradingRules> {
    const info = await this.publicRequest<{ symbols: BinanceSymbolInfo[] }>("/api/v3/exchangeInfo");
    const s = info.symbols.find((x) => x.symbol === symbol);
    if (!s) throw new Error(`Unknown symbol ${symbol}`);
    const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
    const notional = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
    return {
      symbol,
      minQuantity: lot ? parseFloat(lot.minQty ?? "0") : 0,
      maxQuantity: lot ? parseFloat(lot.maxQty ?? "0") : 1e9,
      stepSize: lot ? parseFloat(lot.stepSize ?? "0") : 0,
      minNotional: notional ? parseFloat(notional.minNotional ?? "0") : 0,
      pricePrecision: s.quoteAssetPrecision,
      quantityPrecision: s.baseAssetPrecision,
    };
  }

  async getFees(): Promise<{ makerPct: number; takerPct: number }> {
    return { makerPct: 0.1, takerPct: 0.1 };
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const params = new URLSearchParams();
    params.set("symbol", order.symbol);
    params.set("side", order.side);
    params.set("type", order.orderType);
    params.set("quantity", String(order.quantity));
    if (order.price !== undefined) {
      params.set("price", String(order.price));
      params.set("timeInForce", "GTC");
    }
    if (order.reduceOnly) params.set("reduceOnly", "true");
    const data = await this.signedRequest<BinanceOrderResult>("/api/v3/order", params, "POST");
    const executedQty = parseFloat(data.executedQty);
    if (data.status === "FILLED") {
      const filledPrice = executedQty > 0 ? parseFloat(data.cummulativeQuoteQty) / executedQty : parseFloat(data.price);
      return {
        orderId: String(data.orderId),
        symbol: data.symbol,
        side: order.side,
        filledPrice,
        filledQuantity: executedQty,
        status: "FILLED",
      };
    }
    if (data.status === "PARTIALLY_FILLED" || data.status === "NEW") {
      return {
        orderId: String(data.orderId),
        symbol: data.symbol,
        side: order.side,
        filledPrice: parseFloat(data.cummulativeQuoteQty) > 0 ? parseFloat(data.cummulativeQuoteQty) / executedQty : parseFloat(data.price),
        filledQuantity: executedQty,
        status: "PARTIAL",
      };
    }
    return {
      orderId: String(data.orderId),
      symbol: data.symbol,
      side: order.side,
      filledPrice: 0,
      filledQuantity: 0,
      status: "REJECTED",
      rejectionReason: `Order status ${data.status}`,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const params = new URLSearchParams();
      params.set("orderId", orderId);
      await this.signedRequest<unknown>("/api/v3/order", params, "DELETE");
      return true;
    } catch {
      return false;
    }
  }

  async getOpenOrders(symbol: string): Promise<OrderResult[]> {
    const params = new URLSearchParams();
    params.set("symbol", symbol);
    const data = await this.signedRequest<BinanceOrderResult[]>("/api/v3/openOrders", params);
    return data.map((o) => ({
      orderId: String(o.orderId),
      symbol: o.symbol,
      side: o.side as Side,
      filledPrice: parseFloat(o.price),
      filledQuantity: parseFloat(o.executedQty),
      status: o.status === "FILLED" ? "FILLED" : o.status === "PARTIALLY_FILLED" ? "PARTIAL" : "REJECTED",
    }));
  }

  async closePosition(symbol: string, side: Side, quantity: number): Promise<OrderResult> {
    return this.placeOrder({
      symbol,
      side: side === "BUY" ? "SELL" : "BUY",
      orderType: "MARKET",
      quantity,
      reduceOnly: true,
    });
  }

  async reducePosition(symbol: string, side: Side, quantity: number): Promise<OrderResult> {
    return this.closePosition(symbol, side, quantity);
  }

  // ------------------------------------------------------------------
  // Binance REST plumbing
  // ------------------------------------------------------------------

  private async publicRequest<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`);
    return this.parse<T>(res, path);
  }

  private async signedRequest<T>(
    path: string,
    params: URLSearchParams = new URLSearchParams(),
    method: "GET" | "POST" | "DELETE" = "GET",
  ): Promise<T> {
    params.set("timestamp", String(Date.now()));
    params.set("recvWindow", "10000");
    const query = params.toString();
    const signature = createHmac("sha256", this.apiSecret).update(query).digest("hex");
    const url = `${this.baseUrl}${path}?${query}&signature=${signature}`;
    const res = await this.fetchFn(url, {
      method,
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
    return this.parse<T>(res, path);
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { msg?: string; code?: number };
        detail = body.msg ? `${body.code ?? ""} ${body.msg}`.trim() : JSON.stringify(body);
      } catch {
        detail = await res.text();
      }
      throw new Error(`Binance ${path} ${res.status}: ${detail}`);
    }
    return (await res.json()) as T;
  }
}
