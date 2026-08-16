import type { Analytics, PositionEvent, TradeDetail } from "../api";
import { SetupReasoning } from "./SetupViews";

/**
 * §60 analytics and §53 trade detail. Both render engine-reported values only:
 * where the engine has no data the view says so rather than estimating.
 */

function money(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function num(n?: number, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function pct(n?: number): string {
  return n == null || !Number.isFinite(n) ? "—" : `${num(n, 1)}%`;
}

function factor(n?: number): string {
  if (n == null) return "—";
  if (!Number.isFinite(n)) return "∞";
  return num(n, 2);
}

function duration(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const hours = ms / 3_600_000;
  return hours >= 24 ? `${num(hours / 24, 1)}d` : hours >= 1 ? `${num(hours, 1)}h` : `${num(ms / 60_000, 0)}m`;
}

function time(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function Stat({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Record<string, { trades: number; pnl: number; winRate: number }> }) {
  const entries = Object.entries(rows).sort((a, b) => b[1].pnl - a[1].pnl);
  if (!entries.length) return <div className="empty">No closed trades to break down yet.</div>;
  return (
    <div className="market-table">
      <div className="table-row heading breakdown-row">
        <span>{title}</span><span>Trades</span><span>Win rate</span><span>Net P&amp;L</span>
      </div>
      {entries.map(([key, row]) => (
        <div className="table-row breakdown-row" key={key}>
          <b>{key.replace(/_/g, " ")}</b>
          <span>{row.trades}</span>
          <span>{pct(row.winRate)}</span>
          <span className={row.pnl >= 0 ? "good" : "bad"}>{money(row.pnl)}</span>
        </div>
      ))}
    </div>
  );
}

function EquityCurve({ points }: { points: { timestamp: number; equity: number }[] }) {
  if (points.length < 2) {
    return <div className="empty">The equity curve appears once the account has more than one balance point.</div>;
  }
  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const coords = points
    .map((p, i) => `${(i / (points.length - 1)) * 100},${38 - ((p.equity - min) / range) * 34}`)
    .join(" ");
  return (
    <div className="equity-chart">
      <div>
        <b>{money(values.at(-1))}</b>
        <span>{points.length} points · {time(points.at(-1)?.timestamp)}</span>
      </div>
      <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label="Account equity curve">
        <polyline points={coords} />
      </svg>
      <small>{money(min)} low · {money(max)} high</small>
    </div>
  );
}

export function AnalyticsView({ data }: { data: Analytics | null }) {
  if (!data) return <div className="empty">Loading analytics…</div>;
  const { stats, funnel } = data;

  if (stats.totalTrades === 0) {
    return (
      <>
        <div className="metrics">
          <Stat label="Setups seen" value={funnel.seen} hint="All markets"/>
          <Stat label="Valid" value={funnel.valid} tone="good"/>
          <Stat label="Rejected" value={funnel.rejected} tone="bad"/>
          <Stat label="Execution rate" value={pct(funnel.executionRate)}/>
        </div>
        <div className="empty">
          No closed trades yet.
          <p>
            Performance metrics appear once positions have settled. The engine does not
            trade to fill a quota, so a low execution rate is a valid outcome — the
            reasons below show what it declined.
          </p>
        </div>
        {data.rejectionReasons.length > 0 && <RejectionBreakdown data={data}/>}
      </>
    );
  }

  return (
    <>
      <div className="metrics">
        <Stat label="Net P&L" value={money(stats.netPnl)} tone={stats.netPnl >= 0 ? "good" : "bad"} hint={`${pct(stats.totalReturnPct)} return`}/>
        <Stat label="Win rate" value={pct(stats.winRate)} hint={`${stats.wins}W / ${stats.losses}L`}/>
        <Stat label="Profit factor" value={factor(stats.profitFactor)} hint={`${money(stats.grossProfit)} / ${money(stats.grossLoss)}`}/>
        <Stat label="Max drawdown" value={pct(stats.maxDrawdownPct)} tone="bad" hint={money(stats.maxDrawdown)}/>
      </div>
      <div className="metrics">
        <Stat label="Expectancy" value={money(stats.expectancy)} hint="Per trade"/>
        <Stat label="Average R:R" value={`1:${num(stats.avgRr, 2)}`} hint="Realised"/>
        <Stat label="Trades" value={stats.totalTrades} hint={`${data.openPositions} open`}/>
        <Stat label="Avg duration" value={duration(stats.avgDurationMs)}/>
      </div>

      <div className="two-col">
        <section className="card">
          <div className="card-head"><h2>Equity curve</h2></div>
          <EquityCurve points={data.equityCurve}/>
        </section>
        <section className="card">
          <div className="card-head"><h2>Extremes</h2></div>
          <div className="health-list">
            <div><span>Largest win</span><b className="good">{money(stats.largestWin)}</b></div>
            <div><span>Largest loss</span><b className="bad">{money(stats.largestLoss)}</b></div>
            <div><span>Average win</span><b>{money(stats.avgWin)}</b></div>
            <div><span>Average loss</span><b>{money(stats.avgLoss)}</b></div>
            <div><span>Consecutive wins</span><b>{stats.maxConsecutiveWins}</b></div>
            <div><span>Consecutive losses</span><b>{stats.maxConsecutiveLosses}</b></div>
          </div>
        </section>
      </div>

      <div className="two-col">
        <section className="card">
          <div className="card-head"><h2>Performance by entry model</h2></div>
          <Breakdown title="Entry model" rows={stats.bySetupType}/>
        </section>
        <section className="card">
          <div className="card-head"><h2>Performance by asset</h2></div>
          <Breakdown title="Market" rows={stats.byAsset}/>
        </section>
      </div>

      <RejectionBreakdown data={data}/>
    </>
  );
}

function RejectionBreakdown({ data }: { data: Analytics }) {
  const total = data.rejectionReasons.reduce((sum, r) => sum + r.count, 0);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Why setups were not traded</h2>
        <span className="chart-meta">{data.funnel.rejected} rejected of {data.funnel.seen} seen</span>
      </div>
      {data.rejectionReasons.length === 0 ? (
        <div className="empty">No setups have been rejected yet.</div>
      ) : (
        <div className="reason-bars">
          {data.rejectionReasons.map((row) => (
            <div className="reason-bar" key={row.reason}>
              <div>
                <b>{row.reason}</b>
                <span>{row.count}</span>
              </div>
              <i style={{ width: `${total ? (row.count / total) * 100 : 0}%` }}/>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const EVENT_TONE: Record<string, string> = {
  OPENED: "info",
  TP1_REACHED: "good",
  TP2_REACHED: "good",
  TP3_REACHED: "good",
  PARTIAL_CLOSE: "good",
  BREAK_EVEN: "info",
  SL_MOVED: "info",
  STOP_LOSS_HIT: "bad",
  CLOSED: "info",
};

/** §53 — setup, execution, risk, management timeline, result and outcome. */
export function TradeDetailView({ detail, onBack }: { detail: TradeDetail | null; onBack: () => void }) {
  if (!detail) return <div className="empty">Loading trade…</div>;
  if (!detail.found || !detail.position) {
    return <div className="empty">{detail.reason ?? "Trade not found."}</div>;
  }

  const p = detail.position;
  const closed = p.status === "CLOSED";
  const result = closed ? p.finalPnl ?? p.realizedPnl : p.unrealizedPnl;
  const events: PositionEvent[] = detail.events?.length ? detail.events : p.events ?? [];

  return (
    <>
      <button className="link-button" onClick={onBack}>← Back to positions</button>

      <div className="page-title">
        <div>
          <p className="eyebrow">TRADE DETAIL</p>
          <h1>{p.symbol} {p.direction}</h1>
          <p>
            {p.entryModel ? p.entryModel.replace(/_/g, " ") : "Entry model not recorded"} ·
            opened {time(p.openedAt)}{closed && ` · closed ${time(p.closedAt)}`}
          </p>
        </div>
        <div className={`status-pill ${closed ? (result >= 0 ? "ok" : "bad") : "wait"}`}>
          {closed ? `CLOSED · ${p.closeReason ?? ""}` : "OPEN"}
        </div>
      </div>

      <div className="metrics">
        <Stat label={closed ? "Realised P&L" : "Unrealised P&L"} value={money(result)} tone={result >= 0 ? "good" : "bad"}/>
        <Stat label="Entry" value={num(p.entry)} hint={`Size ${num(p.positionSize, 6)}`}/>
        <Stat label="Stop loss" value={num(p.sl ?? p.stopLoss)} hint={p.sl !== p.stopLoss ? `Originally ${num(p.stopLoss)}` : "Unchanged"}/>
        <Stat label="Notional" value={money(p.notional)} hint={`Fee ${money(p.entryFee)}`}/>
      </div>

      <div className="two-col">
        <section className="card">
          <div className="card-head"><h2>Management timeline</h2></div>
          {events.length === 0 ? (
            <div className="empty">No management events recorded.</div>
          ) : (
            <div className="timeline">
              {[...events].sort((a, b) => a.timestamp - b.timestamp).map((event, i) => (
                <div className={`timeline-item tone-${EVENT_TONE[event.type] ?? "info"}`} key={`${event.timestamp}-${i}`}>
                  <span/>
                  <div>
                    <b>{event.type.replace(/_/g, " ")}</b>
                    <p>{event.detail}</p>
                    <small>
                      {time(event.timestamp)}
                      {event.price != null && ` · ${num(event.price)}`}
                      {event.realizedPnl != null && ` · ${money(event.realizedPnl)}`}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h2>Execution &amp; risk</h2></div>
          <div className="health-list">
            <div><span>Quantity remaining</span><b>{num(p.quantityRemaining, 6)}</b></div>
            <div><span>Quantity closed</span><b>{num(p.closedQuantity, 6)}</b></div>
            <div><span>Max adverse excursion</span><b>{num(p.mae)}</b></div>
            <div><span>Max favourable excursion</span><b>{num(p.mfe)}</b></div>
            <div><span>Planned R:R</span><b>{p.plannedRr?.length ? p.plannedRr.map((r) => `1:${num(r, 1)}`).join(" / ") : "—"}</b></div>
            <div><span>Strategy version</span><b>{p.strategyVersion}</b></div>
          </div>
          <div className="setup-levels" style={{ marginTop: 12 }}>
            {p.takeProfits.map((tp, i) => (
              <div key={i}><span>TP{i + 1}</span><b className="good">{num(tp)}</b></div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Why this trade was opened</h2></div>
        {detail.setup ? (
          <>
            {detail.setup.stopLossReason && <p className="why"><b>Stop loss:</b> {detail.setup.stopLossReason}</p>}
            {detail.setup.takeProfitReasons?.map((reason, i) => (
              <p className="why" key={i}><b>TP{i + 1}:</b> {reason}</p>
            ))}
            <SetupReasoning setup={detail.setup}/>
          </>
        ) : (
          <div className="empty">
            The originating setup has aged out of the current analysis window.
            <p>The journal entries below still record the decision.</p>
          </div>
        )}
      </section>

      {detail.journal && detail.journal.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Journal</h2></div>
          <div className="timeline">
            {detail.journal.map((entry, i) => (
              <div className="timeline-item" key={`${entry.timestamp}-${i}`}>
                <span/>
                <div>
                  <b>{entry.category} · {entry.title}</b>
                  <p>{entry.body}</p>
                  <small>{time(entry.timestamp)}</small>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
