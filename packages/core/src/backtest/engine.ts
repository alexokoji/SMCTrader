import type { RiskConfig, StrategyConfig } from "../config/index.js";
import { PaperExecutionAdapter } from "../execution/paper.js";
import type { MarketDataProvider } from "../marketdata/providers.js";
import { StrategyEngine } from "../strategy/strategy-engine.js";
import type { EquityPoint, BacktestStats } from "./stats.js";
import { computeStats } from "./stats.js";
import { timeframeDuration } from "../types/candles.js";

export interface BacktestTrade {
  setupId: string;
  symbol: string;
  direction: string;
  entry: number;
  exit: number;
  stopLoss: number;
  takeProfits: number[];
  quantity: number;
  pnl: number;
  rr: number;
  score: number;
  entryModel: string;
  openedAt: number;
  closedAt: number;
  durationMs: number;
  mae: number;
  mfe: number;
  closeReason: string;
  strategyVersion: string;
  rejectedReason?: string;
}

export interface BacktestInput {
  symbol: string;
  exchange: string;
  strategyConfig: StrategyConfig;
  riskConfig: RiskConfig;
  startTime: number;
  endTime: number;
  startingEquity: number;
  marketData: MarketDataProvider;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  stats: BacktestStats;
  validSetups: number;
  rejectedSetups: number;
  message: string;
}

export interface BacktestProgress {
  current: number;
  total: number;
  symbol: string;
}

export type BacktestProgressFn = (p: BacktestProgress) => void;

/**
 * Historical replay backtest with no look-ahead:
 * - LTF candles drive the loop; higher-timeframe candles are only fed to the
 *   engine once their close time has passed.
 * - The strategy, risk and position-management code paths are identical to
 *   paper/live trading.
 */
export async function runBacktest(
  input: BacktestInput,
  onProgress?: BacktestProgressFn,
): Promise<BacktestResult> {
  const { strategyConfig, riskConfig, marketData, startTime, endTime } = input;
  const ltf = strategyConfig.timeframes.ltf;
  const mtf = strategyConfig.timeframes.mtf;
  const htf = strategyConfig.timeframes.htf;

  const [ltfCandles, mtfCandles, htfCandles] = await Promise.all([
    marketData.getOHLCV(input.symbol, ltf, startTime, endTime, 10000),
    marketData.getOHLCV(input.symbol, mtf, startTime, endTime, 10000),
    marketData.getOHLCV(input.symbol, htf, startTime, endTime, 10000),
  ]);

  ltfCandles.sort((a, b) => a.timestamp - b.timestamp);
  mtfCandles.sort((a, b) => a.timestamp - b.timestamp);
  htfCandles.sort((a, b) => a.timestamp - b.timestamp);

  if (ltfCandles.length === 0) {
    return {
      trades: [],
      equityCurve: [],
      stats: computeStats([], [], input.startingEquity),
      validSetups: 0,
      rejectedSetups: 0,
      message: "No lower-timeframe candles available for the selected range.",
    };
  }

  let lastPrice = ltfCandles[0].close;
  const paper = new PaperExecutionAdapter({
    initialBalance: input.startingEquity,
    feePct: riskConfig.feePct,
    slippagePct: riskConfig.slippagePct,
    priceProvider: (symbol) => (symbol === input.symbol ? lastPrice : undefined),
  });

  const engine = new StrategyEngine({
    strategy: strategyConfig,
    risk: riskConfig,
    mode: "PAPER",
    execution: paper,
    startingEquity: input.startingEquity,
  });

  const equityCurve: EquityPoint[] = [];
  const ltfDur = timeframeDuration(ltf);
  let mtfIdx = 0;
  let htfIdx = 0;

  const feedDueHigherTimeframes = (closeTime: number) => {
    while (mtfIdx < mtfCandles.length) {
      const c = mtfCandles[mtfIdx];
      if (c.timestamp + timeframeDuration(mtf) <= closeTime) {
        engine.analysis.onCandleClosed(c);
        mtfIdx++;
      } else {
        break;
      }
    }
    while (htfIdx < htfCandles.length) {
      const c = htfCandles[htfIdx];
      if (c.timestamp + timeframeDuration(htf) <= closeTime) {
        engine.analysis.onCandleClosed(c);
        htfIdx++;
      } else {
        break;
      }
    }
  };

  let rejectedCount = 0;
  let validCount = 0;

  for (let i = 0; i < ltfCandles.length; i++) {
    const candle = ltfCandles[i];
    const closeTime = candle.timestamp + ltfDur;
    feedDueHigherTimeframes(closeTime);

    lastPrice = candle.close;
    const cycle = engine.onCandleClosed(candle);
    await engine.flush();
    engine.onPriceBar(input.symbol, candle, closeTime);

    rejectedCount += cycle.rejectedSetups.length;
    validCount += cycle.validSetups.length;

    if (i % 20 === 0 || i === ltfCandles.length - 1) {
      const riskState = engine.getRiskState();
      const unrealized = engine
        .getOpenPositions()
        .reduce((a, p) => a + p.unrealizedPnl, 0);
      equityCurve.push({
        timestamp: closeTime,
        equity: riskState.equity + unrealized,
      });
      onProgress?.({ current: i + 1, total: ltfCandles.length, symbol: input.symbol });
    }
  }

  const trades: BacktestTrade[] = engine
    .getPositions()
    .filter((p) => p.status === "CLOSED")
    .map((p) => {
      const closedEvent = p.events.find((e) => e.type === "CLOSED");
      const exit = closedEvent?.price ?? p.currentPrice;
      const durationMs = closedEvent
        ? closedEvent.timestamp - p.openedAt
        : 0;
      const risk = Math.abs(p.entry - p.stopLoss);
      const rr = risk > 0 ? Math.abs(exit - p.entry) / risk : 0;
      return {
        setupId: p.setupId,
        symbol: p.symbol,
        direction: p.direction,
        entry: p.entry,
        exit,
        stopLoss: p.stopLoss,
        takeProfits: p.takeProfits,
        quantity: p.positionSize,
        pnl: p.finalPnl ?? p.realizedPnl,
        rr,
        score: 0,
        entryModel: "CONFIRMATION",
        openedAt: p.openedAt,
        closedAt: closedEvent?.timestamp ?? 0,
        durationMs,
        mae: p.mae,
        mfe: p.mfe,
        closeReason: p.closeReason ?? "closed",
        strategyVersion: p.strategyVersion,
      };
    });

  const stats = computeStats(trades, equityCurve, input.startingEquity);
  return {
    trades,
    equityCurve,
    stats,
    validSetups: validCount,
    rejectedSetups: rejectedCount,
    message: `Backtest complete: ${trades.length} closed trades over ${ltfCandles.length} ${ltf} candles.`,
  };
}
