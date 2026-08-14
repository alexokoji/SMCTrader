import type { Candle, Side, Timeframe } from "../types/candles.js";

export interface TradingRules {
  symbol: string;
  minQuantity: number;
  maxQuantity: number;
  stepSize: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  orderType: "LIMIT" | "MARKET";
  quantity: number;
  price?: number;
  stopLoss?: number;
  takeProfits?: number[];
  reduceOnly?: boolean;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: Side;
  filledPrice: number;
  filledQuantity: number;
  status: "FILLED" | "REJECTED" | "PARTIAL";
  rejectionReason?: string;
}

export interface Balance {
  totalEquity: number;
  available: number;
  unrealizedPnl: number;
}

export interface AccountPermissions {
  tradingEnabled: boolean;
  withdrawalEnabled: boolean;
}

export interface ConnectionStatus {
  connected: boolean;
  message?: string;
}

/**
 * Common exchange adapter interface. The SMC engine communicates only with
 * this abstraction so additional exchanges can be added without changing
 * strategy logic.
 */
export interface ExchangeAdapter {
  readonly name: string;
  connect(): Promise<ConnectionStatus>;
  validateCredentials(): Promise<{ valid: boolean; permissions: AccountPermissions }>;
  getAccountBalance(): Promise<Balance>;
  getAvailableBalance(): Promise<number>;
  getMarkets(): Promise<string[]>;
  getTicker(symbol: string): Promise<{ price: number }>;
  getOHLCV(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  getTradingRules(symbol: string): Promise<TradingRules>;
  getFees(): Promise<{ makerPct: number; takerPct: number }>;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<boolean>;
  getOpenOrders(symbol: string): Promise<OrderResult[]>;
  closePosition(symbol: string, side: Side, quantity: number): Promise<OrderResult>;
  reducePosition(symbol: string, side: Side, quantity: number): Promise<OrderResult>;
}
