import type { Candle, Side, Timeframe } from "../types/candles.js";
import { hashString } from "../util.js";
import type {
  Balance,
  ConnectionStatus,
  ExchangeAdapter,
  OrderRequest,
  OrderResult,
  TradingRules,
} from "./types.js";

/**
 * Paper / simulation execution adapter. Uses the same code paths as live
 * trading; the only difference is that fills are simulated on a virtual
 * account with configured fees and slippage.
 */
export class PaperExecutionAdapter implements ExchangeAdapter {
  readonly name = "paper";
  private balance: Balance;
  private fees: { makerPct: number; takerPct: number };
  private slippagePct: number;
  private priceProvider: (symbol: string) => number | undefined;
  private orderCounter = 0;

  constructor(opts: {
    initialBalance?: number;
    feePct?: number;
    slippagePct?: number;
    priceProvider?: (symbol: string) => number | undefined;
  }) {
    this.balance = {
      totalEquity: opts.initialBalance ?? 10000,
      available: opts.initialBalance ?? 10000,
      unrealizedPnl: 0,
    };
    this.fees = { makerPct: opts.feePct ?? 0.04, takerPct: opts.feePct ?? 0.04 };
    this.slippagePct = opts.slippagePct ?? 0.05;
    this.priceProvider =
      opts.priceProvider ?? (() => {
        throw new Error("No price provider configured for paper adapter");
      });
  }

  async connect(): Promise<ConnectionStatus> {
    return { connected: true, message: "Virtual account connected" };
  }

  async validateCredentials(): Promise<{ valid: boolean; permissions: { tradingEnabled: boolean; withdrawalEnabled: boolean } }> {
    return { valid: true, permissions: { tradingEnabled: true, withdrawalEnabled: false } };
  }

  async getAccountBalance(): Promise<Balance> {
    return { ...this.balance };
  }

  async getAvailableBalance(): Promise<number> {
    return this.balance.available;
  }

  async getMarkets(): Promise<string[]> {
    return [];
  }

  async getTicker(symbol: string): Promise<{ price: number }> {
    const p = this.priceProvider(symbol);
    if (p === undefined) throw new Error(`No price for ${symbol}`);
    return { price: p };
  }

  async getOHLCV(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    return [];
  }

  async getTradingRules(symbol: string): Promise<TradingRules> {
    return {
      symbol,
      minQuantity: 0.0001,
      maxQuantity: 1e9,
      stepSize: 0.0001,
      minNotional: 5,
      pricePrecision: 2,
      quantityPrecision: 8,
    };
  }

  async getFees(): Promise<{ makerPct: number; takerPct: number }> {
    return this.fees;
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    this.orderCounter += 1;
    const ref = order.price ?? this.priceProvider(order.symbol);
    if (ref === undefined) {
      return {
        orderId: `P${this.orderCounter}`,
        symbol: order.symbol,
        side: order.side,
        filledPrice: 0,
        filledQuantity: 0,
        status: "REJECTED",
        rejectionReason: "No reference price available",
      };
    }
    const slip = order.side === "BUY" ? 1 + this.slippagePct / 100 : 1 - this.slippagePct / 100;
    const fillPrice = ref * slip;
    const fee = (fillPrice * order.quantity * this.fees.takerPct) / 100;
    const notional = fillPrice * order.quantity;
    if (order.side === "BUY") {
      this.balance.available -= notional + fee;
    } else {
      this.balance.available += notional - fee;
    }
    this.balance.totalEquity = this.balance.available;
    return {
      orderId: `P${this.orderCounter}`,
      symbol: order.symbol,
      side: order.side,
      filledPrice: fillPrice,
      filledQuantity: order.quantity,
      status: "FILLED",
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return true;
  }

  async getOpenOrders(symbol: string): Promise<OrderResult[]> {
    return [];
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

  setBalance(b: Balance): void {
    this.balance = b;
  }
}

export function makePaperOrderId(symbol: string, side: Side, seq: number): string {
  return `PAPER-${hashString(`${symbol}:${side}:${seq}`)}`;
}
