import { useState } from "react";
import type {
  AgentSnapshot,
  AgentTrade,
  MarketCondition,
  NewsResult,
  Portfolio,
} from "../agents-api";

/**
 * Agent-centric views. Every figure shown comes from the engine or the
 * supervisor; where a value is absent the view says so rather than filling the
 * gap with a plausible-looking number.
 */

export function money(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function num(n?: number, digits = 2): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function pct(n?: number): string {
  return n == null || !Number.isFinite(n) ? "—" : `${num(n, 1)}%`;
}

function time(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function ago(ts?: number): string {
  if (!ts) return "—";
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const SUPERVISOR_TONE: Record<string, string> = {
  HEALTHY: "ok",
  OBSERVING: "wait",
  TIGHTENING: "warn",
  PAUSED: "bad",
};

/** The agents view: what each agent is, how it is doing, and what its supervisor thinks. */
export function AgentsView({
  agents,
  capital,
  onUpdate,
  onRemove,
  busy,
}: {
  agents: AgentSnapshot[];
  capital: { total: number; committed: number };
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
  busy?: string | null;
}) {
  if (agents.length === 0) {
    return (
      <div className="empty">
        No agents yet.
        <p>
          Create one and assign it capital. Each agent analyses its own markets, keeps its
          own risk limits, and is supervised independently — one agent losing cannot spend
          another&rsquo;s capital.
        </p>
      </div>
    );
  }

  return (
    <div className="agent-grid">
      {agents.map((snapshot) => (
        <AgentCard
          key={snapshot.config.id}
          snapshot={snapshot}
          onUpdate={onUpdate}
          onRemove={onRemove}
          busy={busy}
        />
      ))}
      <p className="helper">
        {money(capital.committed)} of {money(capital.total)} committed ·{" "}
        {money(Math.max(0, capital.total - capital.committed))} free to allocate.
      </p>
    </div>
  );
}

function AgentCard({
  snapshot,
  onUpdate,
  onRemove,
  busy,
}: {
  snapshot: AgentSnapshot;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
  busy?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { config, performance, supervisor, adjustmentHistory } = snapshot;
  const running = config.status === "ACTIVE";
  const tone = SUPERVISOR_TONE[supervisor.state] ?? "wait";
  // The supervisor pausing an agent is a different event from the operator
  // pausing it, and the distinction matters when deciding what to do next.
  const supervisorPaused = config.status === "SUPERVISOR_PAUSED";

  return (
    <article className={`agent-card ${supervisorPaused ? "halted" : ""}`}>
      <header>
        <div>
          <b>{config.name}</b>
          <span>
            {config.mode} · {config.symbols.join(", ")} · {config.timeframes.htf}/
            {config.timeframes.mtf}/{config.timeframes.ltf}
          </span>
        </div>
        <div className={`status-pill ${running ? "ok" : supervisorPaused ? "bad" : "wait"}`}>
          {config.status.replace(/_/g, " ")}
        </div>
      </header>

      <div className="agent-metrics">
        <div><span>Allocated</span><b>{money(config.allocatedCapital)}</b></div>
        <div>
          <span>Equity</span>
          <b className={performance.netPnl >= 0 ? "good" : "bad"}>{money(performance.equity)}</b>
        </div>
        <div>
          <span>Net P&amp;L</span>
          <b className={performance.netPnl >= 0 ? "good" : "bad"}>{money(performance.netPnl)}</b>
        </div>
        <div><span>Trades</span><b>{performance.closedTrades}</b></div>
        <div><span>Win rate</span><b>{performance.closedTrades ? pct(performance.winRate) : "—"}</b></div>
        <div><span>Open</span><b>{performance.openPositions}</b></div>
      </div>

      <div className={`supervisor-note ${tone}`}>
        <b>Supervisor · {supervisor.state.replace(/_/g, " ")}</b>
        <p>{supervisor.headline}</p>
      </div>

      <button className="link-button" onClick={() => setOpen(!open)}>
        {open ? "Hide detail" : "View detail"} →
      </button>

      {open && (
        <div className="agent-detail">
          {supervisor.observations.length > 0 && (
            <>
              <h4>What the supervisor sees</h4>
              <ul className="plain-list">
                {supervisor.observations.map((observation, i) => (
                  <li key={i}>{observation}</li>
                ))}
              </ul>
            </>
          )}

          <h4>Settings in force</h4>
          <div className="setting-rows">
            <SettingRow label="Risk per trade" working={`${num(config.working.riskPerTrade, 2)}%`} baseline={`${num(config.baseline.riskPerTrade, 2)}%`} changed={config.working.riskPerTrade !== config.baseline.riskPerTrade}/>
            <SettingRow label="Minimum R:R" working={`1:${num(config.working.minRr, 1)}`} baseline={`1:${num(config.baseline.minRr, 1)}`} changed={config.working.minRr !== config.baseline.minRr}/>
            <SettingRow label="Minimum score" working={String(config.working.minScore)} baseline={String(config.baseline.minScore)} changed={config.working.minScore !== config.baseline.minScore}/>
          </div>
          <p className="helper">
            Entry models: {config.entryModels.map((m) => m.replace(/_/g, " ")).join(", ")}
          </p>

          {adjustmentHistory.length > 0 && (
            <>
              <h4>Adjustments made</h4>
              <div className="timeline">
                {adjustmentHistory.slice(0, 8).map((adjustment, i) => (
                  <div className="timeline-item" key={i}>
                    <span/>
                    <div>
                      <b>
                        {adjustment.field} {num(adjustment.from, 2)} → {num(adjustment.to, 2)}
                      </b>
                      <p>{adjustment.reason}</p>
                      <small>{time(adjustment.at)}</small>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="card-actions">
            {running ? (
              <button disabled={busy === config.id} onClick={() => onUpdate(config.id, { status: "PAUSED" })}>
                Pause
              </button>
            ) : (
              <button disabled={busy === config.id} onClick={() => onUpdate(config.id, { status: "ACTIVE" })}>
                {supervisorPaused ? "Resume (restores baseline settings)" : "Resume"}
              </button>
            )}
            <button className="danger" disabled={busy === config.id} onClick={() => onRemove(config.id)}>
              Delete
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function SettingRow({ label, working, baseline, changed }: { label: string; working: string; baseline: string; changed: boolean }) {
  return (
    <div className={`setting-row ${changed ? "changed" : ""}`}>
      <span>{label}</span>
      <b>{working}</b>
      {changed && <em>baseline {baseline}</em>}
    </div>
  );
}

export function PortfolioView({ portfolio }: { portfolio: Portfolio | null }) {
  if (!portfolio) return <div className="empty">Loading portfolio…</div>;

  return (
    <>
      <div className="metrics">
        <div className="metric">
          <span>Total equity</span>
          <strong className={portfolio.realisedPnl >= 0 ? "good" : "bad"}>{money(portfolio.equity)}</strong>
          <small>{money(portfolio.totalCapital)} capital</small>
        </div>
        <div className="metric">
          <span>Realised P&amp;L</span>
          <strong className={portfolio.realisedPnl >= 0 ? "good" : "bad"}>{money(portfolio.realisedPnl)}</strong>
          <small>{portfolio.closedTrades} closed trades</small>
        </div>
        <div className="metric">
          <span>Committed</span>
          <strong>{money(portfolio.committed)}</strong>
          <small>{money(portfolio.uncommitted)} free</small>
        </div>
        <div className="metric">
          <span>Win rate</span>
          <strong>{portfolio.closedTrades ? pct(portfolio.winRate) : "—"}</strong>
          <small>{portfolio.openPositions} open</small>
        </div>
      </div>

      <section className="card">
        <div className="card-head"><h2>Capital by agent</h2></div>
        {portfolio.agents.length === 0 ? (
          <div className="empty">No agents are holding capital.</div>
        ) : (
          <div className="market-table">
            <div className="table-row heading agent-row">
              <span>Agent</span><span>Mode</span><span>Allocated</span><span>Equity</span><span>Net P&amp;L</span><span>Open</span>
            </div>
            {portfolio.agents.map((agent) => (
              <div className="table-row agent-row" key={agent.id}>
                <b>{agent.name}</b>
                <span>{agent.mode}</span>
                <span>{money(agent.allocated)}</span>
                <span>{money(agent.equity)}</span>
                <span className={agent.netPnl >= 0 ? "good" : "bad"}>{money(agent.netPnl)}</span>
                <span>{agent.openPositions}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function TradesView({ trades }: { trades: AgentTrade[] }) {
  const [filter, setFilter] = useState<"ALL" | "OPEN" | "CLOSED">("ALL");
  const shown = trades.filter((t) => (filter === "ALL" ? true : t.status === filter));

  if (trades.length === 0) {
    return (
      <div className="empty">
        No trades yet.
        <p>
          Trades appear once an agent&rsquo;s analysis produces a setup that passes every
          rule. Zero trades is a valid outcome — the engine does not trade to fill a quota.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="tf-switch" role="group" aria-label="Filter trades">
        {(["ALL", "OPEN", "CLOSED"] as const).map((option) => (
          <button key={option} className={filter === option ? "selected" : ""} onClick={() => setFilter(option)}>
            {option}
          </button>
        ))}
      </div>
      <div className="market-table">
        <div className="table-row heading trade-row">
          <span>Agent</span><span>Market</span><span>Model</span><span>Entry / exit</span><span>Size</span><span>Result</span><span>Status</span>
        </div>
        {shown.map((trade) => {
          const result = trade.status === "CLOSED" ? trade.finalPnl ?? trade.realizedPnl : trade.unrealizedPnl;
          return (
            <div className="table-row trade-row" key={trade.id}>
              <b>{trade.agentName}</b>
              <span>{trade.symbol} <small>{trade.direction}</small></span>
              <span>{trade.entryModel?.replace(/_/g, " ") ?? "—"}</span>
              <span>{num(trade.entry)} / {trade.status === "CLOSED" ? num(trade.currentPrice) : "—"}</span>
              <span>{num(trade.positionSize, 6)}</span>
              <span className={result >= 0 ? "good" : "bad"}>{money(result)}</span>
              <span>
                {trade.status === "CLOSED" ? trade.closeReason?.replace(/_/g, " ") ?? "CLOSED" : "OPEN"}
                <small> {ago(trade.closedAt ?? trade.openedAt)}</small>
              </span>
            </div>
          );
        })}
        {shown.length === 0 && <div className="empty">No {filter.toLowerCase()} trades.</div>}
      </div>
    </>
  );
}

const REGIME_TONE: Record<string, string> = {
  TRENDING_UP: "ok",
  TRENDING_DOWN: "bad",
  RANGING: "wait",
  VOLATILE: "warn",
  QUIET: "wait",
  UNKNOWN: "wait",
};

export function ConditionsView({
  conditions,
  updatedAt,
}: {
  conditions: MarketCondition[];
  updatedAt: number | null;
}) {
  if (conditions.length === 0) {
    return (
      <div className="empty">
        No conditions recorded yet.
        <p>Conditions are classified each time an agent analyses one of its markets.</p>
      </div>
    );
  }

  return (
    <>
      <p className="helper">Last classified {ago(updatedAt ?? undefined)}.</p>
      <div className="condition-grid">
        {conditions.map((condition) => (
          <article className="condition-card" key={condition.symbol}>
            <header>
              <b>{condition.symbol}</b>
              <span className={`status-pill ${REGIME_TONE[condition.regime] ?? "wait"}`}>
                {condition.regime.replace(/_/g, " ")}
              </span>
            </header>
            <div className="condition-metrics">
              <div><span>Volatility</span><b>{pct(condition.volatilityPct)}</b></div>
              <div><span>Efficiency</span><b>{pct(condition.efficiency * 100)}</b></div>
              <div><span>Confidence</span><b>{pct(condition.confidence * 100)}</b></div>
            </div>
            <p className="helper">{condition.detail}</p>
          </article>
        ))}
      </div>
    </>
  );
}

export function NewsView({ news }: { news: NewsResult | null }) {
  if (!news) return <div className="empty">Loading news…</div>;

  if (news.unavailable) {
    return (
      <div className="empty">
        News feeds are unreachable right now.
        <p>
          This is a feed problem, not quiet markets. Sources tried:{" "}
          {news.sources.map((s) => `${s.name} (${s.detail ?? "failed"})`).join(", ")}.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="helper">
        {news.items.length} headlines · updated {ago(news.fetchedAt)} ·{" "}
        {news.sources.filter((s) => s.ok).map((s) => s.name).join(", ")}
      </p>
      <div className="news-list">
        {news.items.map((item) => (
          <a className={`news-item ${item.sentiment.toLowerCase()}`} key={item.id} href={item.url} target="_blank" rel="noreferrer noopener">
            <div>
              <b>{item.title}</b>
              <span>
                {item.source} · {ago(item.publishedAt)}
                {item.symbols.length > 0 && ` · ${item.symbols.join(", ")}`}
              </span>
            </div>
            <em>{item.sentiment}</em>
          </a>
        ))}
      </div>
      <p className="helper">
        News is context only. It never opens a position: a negative headline can make an
        agent more cautious on that market, never more willing.
      </p>
    </>
  );
}
