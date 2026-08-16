import type { Direction } from "../types/candles.js";
import type { PartialClosePlanItem, PortfolioPosition } from "../types/risk.js";
import { hashString, round } from "../util.js";

export type PositionEventType =
  | "OPENED"
  | "PRICE_UPDATED"
  | "TP1_REACHED"
  | "TP2_REACHED"
  | "TP3_REACHED"
  | "PARTIAL_CLOSE"
  | "BREAK_EVEN"
  | "SL_MOVED"
  | "STOP_LOSS_HIT"
  | "TRAILING_SL"
  | "CLOSED"
  | "RECONCILIATION";

export interface PositionEvent {
  type: PositionEventType;
  timestamp: number;
  detail: string;
  positionId: string;
  price?: number;
  qtyClosed?: number;
  realizedPnl?: number;
  pnl?: number;
}

export interface ManagedPosition extends PortfolioPosition {
  sl: number;
  quantityRemaining: number;
  closedQuantity: number;
  realizedPnl: number;
  entryFee: number;
  events: PositionEvent[];
  status: "OPEN" | "CLOSED";
  closeReason?: string;
  finalPnl?: number;
  /** maximum adverse excursion in price units */
  mae: number;
  /** maximum favorable excursion in price units */
  mfe: number;
}

export interface PositionManagerOptions {
  feePct: number;
  slippagePct: number;
  breakEvenOnTp1: boolean;
  partialPlan: PartialClosePlanItem[];
}

export class PositionManager {
  private opts: PositionManagerOptions;
  private positions: Map<string, ManagedPosition> = new Map();

  constructor(opts: PositionManagerOptions) {
    this.opts = opts;
  }

  /** Apply changed trade-management settings at runtime (BE, partial plan, fees). */
  updateOptions(patch: Partial<PositionManagerOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  openPosition(input: {
    symbol: string;
    exchange: string;
    direction: Direction;
    setupId: string;
    strategyVersion: string;
    entry: number;
    positionSize: number;
    notional: number;
    stopLoss: number;
    takeProfits: number[];
    partialPlan?: PartialClosePlanItem[];
    openedAt: number;
    feePct?: number;
  }): ManagedPosition {
    const id = `POS-${hashString(
      `${input.symbol}:${input.direction}:${input.setupId}:${input.openedAt}`,
    )}`;
    const fee =
      ((input.notional ?? input.positionSize * input.entry) *
        (input.feePct ?? this.opts.feePct)) /
      100;
    const pos: ManagedPosition = {
      id,
      symbol: input.symbol,
      exchange: input.exchange,
      direction: input.direction,
      setupId: input.setupId,
      strategyVersion: input.strategyVersion,
      entry: input.entry,
      positionSize: input.positionSize,
      notional: input.notional,
      stopLoss: input.stopLoss,
      takeProfits: input.takeProfits,
      partialPlan: input.partialPlan ?? this.opts.partialPlan,
      currentPrice: input.entry,
      unrealizedPnl: 0,
      openedAt: input.openedAt,
      sl: input.stopLoss,
      quantityRemaining: input.positionSize,
      closedQuantity: 0,
      realizedPnl: 0,
      entryFee: fee,
      events: [
        {
          type: "OPENED",
          timestamp: input.openedAt,
          positionId: id,
          detail: `Position opened at ${input.entry.toFixed(2)}, size ${input.positionSize.toFixed(6)}, SL ${input.stopLoss.toFixed(2)}.`,
          price: input.entry,
        },
      ],
      status: "OPEN",
      mae: 0,
      mfe: 0,
    };
    this.positions.set(id, pos);
    return pos;
  }

  /** Feed a new price (from the price feed) and process SL/TP logic. */
  onPrice(symbol: string, price: number, timestamp: number): PositionEvent[] {
    return this.onBar(symbol, { high: price, low: price, close: price }, timestamp);
  }

  /**
   * Process SL/TP logic against a full bar (intrabar approximation).
   * For each position the stop is checked first (conservative), then
   * take-profits in ascending order.
   */
  onBar(
    symbol: string,
    bar: { high: number; low: number; close: number },
    timestamp: number,
  ): PositionEvent[] {
    const events: PositionEvent[] = [];
    for (const pos of this.positions.values()) {
      if (pos.status !== "OPEN" || pos.symbol !== symbol) continue;
      // a position opened on this same bar must not be managed against it
      if (pos.openedAt >= timestamp) continue;
      pos.currentPrice = bar.close;
      pos.unrealizedPnl = this.unrealizedPnl(pos, bar.close);

      const long = pos.direction === "LONG";

      // track MAE/MFE in price units
      if (long) {
        pos.mae = Math.max(pos.mae, pos.entry - bar.low);
        pos.mfe = Math.max(pos.mfe, bar.high - pos.entry);
      } else {
        pos.mae = Math.max(pos.mae, bar.high - pos.entry);
        pos.mfe = Math.max(pos.mfe, pos.entry - bar.low);
      }

      // SL check first
      if ((long && bar.low <= pos.sl) || (!long && bar.high >= pos.sl)) {
        const pnl = this.realizedPnlOf(pos, pos.quantityRemaining, pos.sl);
        const ev: PositionEvent = {
          type: "STOP_LOSS_HIT",
          timestamp,
          positionId: pos.id,
          detail: `Stop loss hit at ${pos.sl.toFixed(2)}. Remaining ${pos.quantityRemaining.toFixed(6)} closed for ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}.`,
          price: pos.sl,
          qtyClosed: pos.quantityRemaining,
          realizedPnl: pnl,
        };
        events.push(ev);
        this.closePosition(pos, pos.quantityRemaining, pos.sl, timestamp, "Stop loss", pnl);
        pos.events.push(ev);
        continue;
      }

      // TP checks (in order)
      for (let i = 0; i < pos.takeProfits.length; i++) {
        const tp = pos.takeProfits[i];
        if (tp === undefined) continue;
        const hit = long ? bar.high >= tp : bar.low <= tp;
        if (!hit) continue;
        const planItem = pos.partialPlan.find((p) => p.targetIndex === i + 1);
        const isLastTp = i === pos.takeProfits.length - 1;
        const closePct = isLastTp ? 100 : planItem?.closePct ?? 50;
        const qtyToClose = (pos.quantityRemaining * closePct) / 100;
        if (qtyToClose <= 0) continue;
        const pnl = this.realizedPnlOf(pos, qtyToClose, tp);
        const ev: PositionEvent = {
          type: i === 0 ? "TP1_REACHED" : i === 1 ? "TP2_REACHED" : "TP3_REACHED",
          timestamp,
          positionId: pos.id,
          detail: `${i === 0 ? "TP1" : i === 1 ? "TP2" : "TP3"} reached at ${tp.toFixed(2)}. Closing ${closePct}% of remaining position for ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}.`,
          price: tp,
          qtyClosed: qtyToClose,
          realizedPnl: pnl,
        };
        events.push(ev);
        this.closePosition(pos, qtyToClose, tp, timestamp, `TP${i + 1}`, pnl);
        pos.events.push(ev);
        if (planItem?.moveSlToBreakEven && this.opts.breakEvenOnTp1) {
          const newSl = pos.entry;
          pos.sl = newSl;
          pos.stopLoss = newSl;
          const ev2: PositionEvent = {
            type: "BREAK_EVEN",
            timestamp,
            positionId: pos.id,
            detail: `SL moved to break-even (${newSl.toFixed(2)}).`,
            price: newSl,
          };
          events.push(ev2);
          pos.events.push(ev2);
        }
      }
    }
    return events;
  }

  private realizedPnlOf(pos: ManagedPosition, qty: number, price: number): number {
    const raw =
      pos.direction === "LONG"
        ? (price - pos.entry) * qty
        : (pos.entry - price) * qty;
    const fee = (price * qty * this.opts.feePct) / 100;
    return raw - fee;
  }

  private unrealizedPnl(pos: ManagedPosition, price: number): number {
    const raw =
      pos.direction === "LONG"
        ? (price - pos.entry) * pos.quantityRemaining
        : (pos.entry - price) * pos.quantityRemaining;
    return raw;
  }

  private closePosition(
    pos: ManagedPosition,
    qty: number,
    price: number,
    timestamp: number,
    reason: string,
    pnl: number,
  ): void {
    pos.closedQuantity += qty;
    pos.quantityRemaining -= qty;
    pos.realizedPnl += pnl;
    pos.quantityRemaining = Math.max(0, round(pos.quantityRemaining, 8));
    if (pos.quantityRemaining <= 0) {
      pos.status = "CLOSED";
      pos.closeReason = reason;
      pos.finalPnl = pos.realizedPnl - pos.entryFee;
      pos.events.push({
        type: "CLOSED",
        timestamp,
        positionId: pos.id,
        detail: `Position closed (${reason}). Final P/L: ${pos.finalPnl >= 0 ? "+" : ""}${pos.finalPnl.toFixed(2)}.`,
        price,
        realizedPnl: pos.finalPnl,
      });
    } else {
      pos.events.push({
        type: "PARTIAL_CLOSE",
        timestamp,
        positionId: pos.id,
        detail: `Partial close of ${qty.toFixed(6)} at ${price.toFixed(2)}. Realized ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}.`,
        price,
        qtyClosed: qty,
        realizedPnl: pnl,
      });
    }
  }

  getOpenPositions(symbol?: string): ManagedPosition[] {
    const list = [...this.positions.values()].filter((p) => p.status === "OPEN");
    return symbol ? list.filter((p) => p.symbol === symbol) : list;
  }

  getClosedPositions(): ManagedPosition[] {
    return [...this.positions.values()].filter((p) => p.status === "CLOSED");
  }

  getAll(): ManagedPosition[] {
    return [...this.positions.values()];
  }

  /**
   * Replace tracked positions with a persisted snapshot. Used when a host that
   * cannot hold the manager in memory indefinitely (such as an evicted Durable
   * Object) rebuilds the engine from storage.
   */
  restore(positions: ManagedPosition[]): void {
    this.positions = new Map(
      positions
        .filter((p) => typeof p?.id === "string")
        .map((p) => [p.id, { ...p, events: [...(p.events ?? [])] }]),
    );
  }

  updateSl(symbol: string, id: string, newSl: number, timestamp: number, reason: string): void {
    const pos = this.positions.get(id);
    if (!pos || pos.symbol !== symbol || pos.status !== "OPEN") return;
    pos.sl = newSl;
    pos.stopLoss = newSl;
    pos.events.push({
      type: "SL_MOVED",
      timestamp,
      positionId: id,
      detail: `${reason}. SL moved to ${newSl.toFixed(2)}.`,
      price: newSl,
    });
  }
}
