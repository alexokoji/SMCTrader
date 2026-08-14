import type { BacktestTrade } from "./engine.js";

export interface EquityPoint {
  timestamp: number;
  equity: number;
}

export interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  expectancy: number;
  avgTrade: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgRr: number;
  avgDurationMs: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  finalEquity: number;
  totalReturnPct: number;
  sharpe: number;
  byMonth: Record<string, number>;
  bySetupType: Record<string, { trades: number; pnl: number; winRate: number }>;
  byAsset: Record<string, { trades: number; pnl: number; winRate: number }>;
}

export function computeStats(
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
  startingEquity: number,
): BacktestStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = losses.reduce((a, t) => a + t.pnl, 0);
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);

  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let run = 0;
  let runType: "W" | "L" | "" = "";
  for (const t of trades) {
    const type = t.pnl > 0 ? "W" : "L";
    if (type === runType) {
      run++;
    } else {
      run = 1;
      runType = type;
    }
    if (type === "W" && run > maxConsecutiveWins) maxConsecutiveWins = run;
    if (type === "L" && run > maxConsecutiveLosses) maxConsecutiveLosses = run;
  }

  let maxDrawdown = 0;
  let peak = startingEquity;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak - point.equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const maxDrawdownPct = peak > 0 ? (maxDrawdown / peak) * 100 : 0;

  const returns = trades.map((t) => t.pnl / startingEquity);
  const meanReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 1
      ? returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (returns.length - 1)
      : 0;
  const sharpe = variance > 0 ? (meanReturn / Math.sqrt(variance)) * Math.sqrt(365) : 0;

  const byMonth: Record<string, number> = {};
  for (const t of trades) {
    const key = new Date(t.openedAt).toISOString().slice(0, 7);
    byMonth[key] = (byMonth[key] ?? 0) + t.pnl;
  }

  const bySetupType: BacktestStats["bySetupType"] = {};
  const byAsset: BacktestStats["byAsset"] = {};
  for (const t of trades) {
    const st = bySetupType[t.entryModel] ?? { trades: 0, pnl: 0, winRate: 0 };
    st.trades += 1;
    st.pnl += t.pnl;
    if (t.pnl > 0) st.winRate += 1;
    bySetupType[t.entryModel] = st;
    const as = byAsset[t.symbol] ?? { trades: 0, pnl: 0, winRate: 0 };
    as.trades += 1;
    as.pnl += t.pnl;
    if (t.pnl > 0) as.winRate += 1;
    byAsset[t.symbol] = as;
  }
  for (const key of Object.keys(bySetupType)) {
    bySetupType[key].winRate =
      bySetupType[key].trades > 0
        ? (bySetupType[key].winRate / bySetupType[key].trades) * 100
        : 0;
  }
  for (const key of Object.keys(byAsset)) {
    byAsset[key].winRate =
      byAsset[key].trades > 0 ? (byAsset[key].winRate / byAsset[key].trades) * 100 : 0;
  }

  const finalEquity = equityCurve.length
    ? equityCurve[equityCurve.length - 1].equity
    : startingEquity;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    netPnl,
    grossProfit,
    grossLoss: Math.abs(grossLoss),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: trades.length ? netPnl / trades.length : 0,
    avgTrade: trades.length ? netPnl / trades.length : 0,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    avgRr: trades.length ? trades.reduce((a, t) => a + t.rr, 0) / trades.length : 0,
    avgDurationMs: trades.length
      ? trades.reduce((a, t) => a + t.durationMs, 0) / trades.length
      : 0,
    maxDrawdown,
    maxDrawdownPct,
    finalEquity,
    totalReturnPct: startingEquity > 0 ? ((finalEquity - startingEquity) / startingEquity) * 100 : 0,
    sharpe,
    byMonth,
    bySetupType,
    byAsset,
  };
}
