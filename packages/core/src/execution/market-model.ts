/**
 * Execution cost model for paper trading.
 *
 * The point of paper trading is to predict live results, so every cost here
 * exists because omitting it makes paper optimistic. Each is applied against
 * the trader, never in their favour.
 *
 * What is modelled: the bid/ask spread, slippage that grows with order size
 * relative to available depth and with volatility, additional slippage through
 * a stop, maker and taker fees, funding on positions held over time, and
 * exchange lot/notional minimums. What remains unmodelled is stated in the
 * README rather than hidden here: queue position, latency, and outages.
 */

export interface MarketModelConfig {
  /** Half-spread as a percent of price, applied on entry and exit. */
  spreadPct: number;
  /**
   * Notional, in quote currency, that can be absorbed before slippage reaches
   * one unit of `baseSlippagePct`. Thin markets should use a smaller figure.
   */
  depthNotional: number;
  /** Slippage at one unit of depth, as a percent of price. */
  baseSlippagePct: number;
  /**
   * Extra slippage when a stop is triggered, as a multiple of base slippage.
   * A stop is a market order into a move that is already going against it.
   */
  stopSlippageMultiple: number;
  makerFeePct: number;
  takerFeePct: number;
  /** Funding rate per 8 hours, as a percent of notional. */
  fundingRatePct: number;
  /** Smallest tradeable quantity. */
  minQuantity: number;
  /** Smallest tradeable notional in quote currency. */
  minNotional: number;
}

/**
 * Defaults sized on liquid USDT perpetuals. They are deliberately not
 * optimistic: a thin market will be worse, and should be configured as such.
 */
export const DEFAULT_MARKET_MODEL: MarketModelConfig = {
  spreadPct: 0.02,
  depthNotional: 50_000,
  baseSlippagePct: 0.05,
  stopSlippageMultiple: 2.5,
  makerFeePct: 0.02,
  takerFeePct: 0.055,
  fundingRatePct: 0.01,
  minQuantity: 0.0001,
  minNotional: 5,
};

export type FillKind = "ENTRY" | "TARGET" | "STOP";

export interface FillRequest {
  side: "BUY" | "SELL";
  /** The price the strategy intended to transact at. */
  referencePrice: number;
  quantity: number;
  kind: FillKind;
  /** Recent average true range as a fraction of price, if known. */
  volatilityPct?: number;
}

export interface Fill {
  price: number;
  quantity: number;
  fee: number;
  /** Difference between the intended and achieved price, in quote currency. */
  slippageCost: number;
  spreadCost: number;
  /** True when the order is charged the taker fee. */
  taker: boolean;
}

/**
 * Slippage as a percent of price.
 *
 * It grows with the square root of size relative to depth, which is the usual
 * shape of market impact: the first units fill near the touch and each
 * subsequent slice reaches further into the book. Volatility widens it, since
 * the book thins exactly when the engine most wants to trade.
 */
export function slippagePctFor(
  notional: number,
  config: MarketModelConfig,
  volatilityPct = 0,
): number {
  if (notional <= 0) return 0;
  const sizeFactor = Math.sqrt(Math.max(notional, 0) / Math.max(config.depthNotional, 1));
  // Volatility at 1% of price doubles the impact.
  const volatilityFactor = 1 + Math.max(0, volatilityPct);
  return config.baseSlippagePct * sizeFactor * volatilityFactor;
}

/**
 * Price and cost of a fill. Entries and stops cross the spread and pay taker
 * fees; a take-profit is treated as resting liquidity and pays the maker fee,
 * which is the most favourable assumption made anywhere in this model.
 */
export function simulateFill(request: FillRequest, config: MarketModelConfig): Fill {
  const notional = request.referencePrice * request.quantity;
  const taker = request.kind !== "TARGET";

  let slippagePct = slippagePctFor(notional, config, request.volatilityPct);
  if (request.kind === "STOP") slippagePct *= config.stopSlippageMultiple;
  // A resting target is filled at its price when touched, so it suffers no
  // impact; it still gives up the spread.
  if (request.kind === "TARGET") slippagePct = 0;

  // Both the spread and the slippage move the price against the trader.
  const adverse = request.side === "BUY" ? 1 : -1;
  const spreadAdjustment = request.referencePrice * (config.spreadPct / 100) * adverse;
  const slippageAdjustment = request.referencePrice * (slippagePct / 100) * adverse;
  const price = request.referencePrice + spreadAdjustment + slippageAdjustment;

  const feePct = taker ? config.takerFeePct : config.makerFeePct;
  const fee = Math.abs(price * request.quantity * (feePct / 100));

  return {
    price,
    quantity: request.quantity,
    fee,
    slippageCost: Math.abs(slippageAdjustment * request.quantity),
    spreadCost: Math.abs(spreadAdjustment * request.quantity),
    taker,
  };
}

/**
 * Whether an order is large enough for the exchange to accept. A position the
 * risk engine sized below the minimum would be silently impossible live.
 */
export function meetsExchangeMinimums(
  quantity: number,
  price: number,
  config: MarketModelConfig,
): { ok: boolean; reason?: string } {
  if (quantity < config.minQuantity) {
    return { ok: false, reason: `Quantity ${quantity} is below the exchange minimum of ${config.minQuantity}.` };
  }
  if (quantity * price < config.minNotional) {
    return {
      ok: false,
      reason: `Notional ${(quantity * price).toFixed(2)} is below the exchange minimum of ${config.minNotional}.`,
    };
  }
  return { ok: true };
}

/**
 * Funding paid on a position held across funding intervals.
 *
 * Charged against the trader regardless of side: predicting which way funding
 * will point is not something this model attempts, and assuming it pays would
 * be exactly the kind of optimism this module exists to remove.
 */
export function fundingCost(
  notional: number,
  heldMs: number,
  config: MarketModelConfig,
): number {
  const intervals = Math.floor(heldMs / (8 * 60 * 60 * 1000));
  if (intervals <= 0) return 0;
  return Math.abs(notional) * (config.fundingRatePct / 100) * intervals;
}

/**
 * Whether a resting limit order at `price` would have filled within a bar.
 *
 * Touching a price is not the same as being filled at it: the order joins a
 * queue. Requiring the bar to trade decisively through the level approximates
 * that, and removes the largest source of paper optimism, which is assuming
 * every intended entry is achieved.
 */
export function limitOrderFilled(
  side: "BUY" | "SELL",
  price: number,
  bar: { high: number; low: number },
  config: MarketModelConfig,
): boolean {
  // The book must trade past the level by at least the spread for a resting
  // order to be confident of a fill rather than merely being touched.
  const margin = price * (config.spreadPct / 100);
  return side === "BUY" ? bar.low <= price - margin : bar.high >= price + margin;
}
