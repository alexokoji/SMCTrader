import type { LiveStatus, MarketStatus } from "../agents-api";

/**
 * What the engine is doing right now.
 *
 * Without this, "no valid setup" and "the loop has stopped" look identical from
 * the outside: both show numbers that do not move. This states which it is, and
 * for every market what the engine last concluded and why.
 */

function ago(ts?: number | null): string {
  if (!ts) return "never";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function until(ts?: number | null): string {
  if (!ts) return "not scheduled";
  const seconds = Math.round((ts - Date.now()) / 1000);
  if (seconds <= 0) return "due now";
  return seconds < 60 ? `in ${seconds}s` : `in ${Math.round(seconds / 60)}m`;
}

/** The engine's own words for a market, or a plain statement that it is idle. */
function marketNote(market: MarketStatus): string {
  if (market.warming) return "Loading history before its analysis is authoritative.";
  if (market.blocked.length > 0) return market.blocked[0];
  if (market.reason) return market.reason;
  if (market.setups > 0) return `${market.setups} setup${market.setups === 1 ? "" : "s"} under evaluation.`;
  return "Analysed, nothing tradeable.";
}

const STATUS_TONE: Record<string, string> = {
  READY: "ok",
  ORDER_SUBMITTED: "ok",
  REJECTED: "warn",
  WARMING_UP: "wait",
  NO_HTF_BIAS: "wait",
  WAITING_FOR_POI: "wait",
  WAITING_FOR_DATA: "wait",
  SAFE_MODE: "bad",
};

export function LiveStatusPanel({ status }: { status: LiveStatus | null }) {
  if (!status) {
    return (
      <section className="card">
        <div className="card-head"><h2>Engine activity</h2></div>
        <div className="empty">Loading…</div>
      </section>
    );
  }

  const totalMarkets = status.agents.reduce((sum, agent) => sum + agent.markets.length, 0);
  const analysing = status.agents.reduce(
    (sum, agent) => sum + agent.markets.filter((m) => !m.warming).length,
    0,
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>Engine activity</h2>
        <span className={`status-pill ${status.running ? "ok" : "bad"}`}>
          {status.running ? "RUNNING" : "STALLED"}
        </span>
      </div>

      <div className="heartbeat">
        <div>
          <span>Last analysis</span>
          <b>{ago(status.lastTickAt)}</b>
        </div>
        <div>
          <span>Next</span>
          <b>{until(status.nextTickAt)}</b>
        </div>
        <div>
          <span>Markets analysed</span>
          <b>{analysing} / {totalMarkets}</b>
        </div>
      </div>

      <p className={`helper ${status.running ? "" : "bad"}`}>{status.health}</p>

      {status.agents.length === 0 ? (
        <div className="empty">
          No active agent has been analysed yet.
          <p>An agent must be ACTIVE for the engine to work on its markets.</p>
        </div>
      ) : (
        status.agents.map((agent) => (
          <div className="live-agent" key={agent.id}>
            <header>
              <b>{agent.name}</b>
              <span>
                {agent.supervisor} · {agent.openPositions} open
              </span>
            </header>
            <div className="live-markets">
              {agent.markets.map((market) => (
                <div className="live-market" key={market.symbol}>
                  <div className="live-market-head">
                    <b>{market.symbol}</b>
                    <span className={`status-pill ${STATUS_TONE[market.status] ?? "wait"}`}>
                      {market.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="live-market-meta">
                    <span>{market.bias}</span>
                    {market.regime && <span>{market.regime.replace(/_/g, " ")}</span>}
                    {market.executed > 0 && <span className="good">{market.executed} opened</span>}
                    {market.rejected > 0 && <span>{market.rejected} declined</span>}
                  </div>
                  <p>{marketNote(market)}</p>
                </div>
              ))}
              {agent.markets.length === 0 && (
                <p className="helper">No market of this agent was analysed on the last pass.</p>
              )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
