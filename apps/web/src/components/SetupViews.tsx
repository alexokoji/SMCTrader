import { useState } from "react";
import type { AnalysisResult, ConfluenceFactor, Setup } from "../api";

/**
 * These views render only what the engine reported. Nothing here infers a
 * reason, a score or a verdict of its own: if the engine did not supply a
 * field, the UI says so rather than filling the gap.
 */

function num(value?: number, digits = 2): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function time(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function FactorRow({ factor }: { factor: ConfluenceFactor }) {
  const icon = factor.status === "PASS" ? "✓" : factor.status === "FAIL" ? "✕" : "•";
  return (
    <li className={`factor ${factor.status.toLowerCase()}`}>
      <span aria-hidden="true">{icon}</span>
      <div>
        <b>{factor.name}</b>
        <p>{factor.detail}</p>
      </div>
      <em>{factor.status}</em>
    </li>
  );
}

/**
 * §50 — the panel beside the chart. States what the engine sees, what it is
 * waiting for, and why, using the deterministic explanation payload.
 */
export function AnalysisExplanation({ analysis }: { analysis: AnalysisResult | null }) {
  if (!analysis) return <div className="empty">Waiting for the first analysis cycle.</div>;

  const valid = analysis.setups.filter((s) => s.status === "VALID");
  const leading = valid[0] ?? analysis.setups[0];

  return (
    <div className="explain-panel">
      {analysis.warming && (
        <div className="warning">
          {analysis.message ?? "The engine is replaying stored history. Analysis is not authoritative yet."}
        </div>
      )}

      <div className="explain-row">
        <span>Bias</span>
        <b className={analysis.bias === "BULLISH" ? "good" : analysis.bias === "BEARISH" ? "bad" : ""}>
          {analysis.bias}
        </b>
      </div>
      <div className="explain-row">
        <span>State</span>
        <b>{analysis.status.replace(/_/g, " ")}</b>
      </div>

      <div className="tf-stack">
        {([
          ["HTF", analysis.topDown?.htf],
          ["MTF", analysis.topDown?.mtf],
          ["LTF", analysis.topDown?.ltf],
        ] as const).map(([label, tf]) => (
          <div key={label}>
            <span>{label}</span>
            <b>{tf?.timeframe ?? "—"}</b>
            <em className={tf?.trend === "BULLISH" ? "good" : tf?.trend === "BEARISH" ? "bad" : ""}>
              {tf?.trend ?? "—"}
            </em>
          </div>
        ))}
      </div>

      {analysis.topDown?.conflict && (
        <p className="conflict">{analysis.topDown.conflict}</p>
      )}

      {leading ? (
        <>
          <h3>
            {leading.direction} · {leading.entryModel.replace(/_/g, " ")}
            {leading.counterTrend && <span className="counter-tag">COUNTER-TREND</span>}
          </h3>
          <SetupReasoning setup={leading} />
        </>
      ) : (
        <>
          <p className="helper">
            {analysis.noTradeReason
              ?? "No setup is on the table. The engine trades only when its conditions are met, so zero setups is a valid outcome."}
          </p>
          {analysis.noTradeReason && (
            <p className="helper">
              Zero setups is a valid outcome. The engine does not trade to fill a quota.
            </p>
          )}
        </>
      )}

      {analysis.message && !analysis.warming && <p className="helper">{analysis.message}</p>}
    </div>
  );
}

/** Hard rules, quality factors and the engine's reason strings for one setup. */
export function SetupReasoning({ setup }: { setup: Setup }) {
  const hardRules = setup.hardRules ?? [];
  const quality = setup.qualityFactors ?? [];
  const factors = setup.factors ?? [];

  return (
    <div className="reasoning">
      {hardRules.length > 0 && (
        <>
          <h4>Mandatory conditions</h4>
          <ul className="factor-list">
            {hardRules.map((f, i) => <FactorRow key={`h-${i}`} factor={f} />)}
          </ul>
        </>
      )}

      {factors.length > 0 && (
        <>
          <h4>Confluence</h4>
          <ul className="factor-list">
            {factors.map((f, i) => <FactorRow key={`f-${i}`} factor={f} />)}
          </ul>
        </>
      )}

      {quality.length > 0 && (
        <>
          <h4>Quality factors (ranking only)</h4>
          <ul className="factor-list">
            {quality.map((f, i) => <FactorRow key={`q-${i}`} factor={f} />)}
          </ul>
        </>
      )}

      {setup.rejectionReasons.length > 0 && (
        <div className="reject-box">
          <b>Not traded</b>
          <ul>{setup.rejectionReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}

      {setup.reasons.length > 0 && (
        <div className="reason-box">
          <ul>{setup.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/** §51 — the full trade card, including why the stop and each target sit where they do. */
export function SetupCard({ setup, defaultOpen = false }: { setup: Setup; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const executed = setup.status === "EXECUTED";
  const rejected = setup.status === "REJECTED" || setup.status === "INVALIDATED" || setup.status === "STALE";

  return (
    <article className={`setup-card ${executed ? "executed" : rejected ? "rejected" : ""}`}>
      <header>
        <div>
          <b>
            {setup.symbol ?? ""} {setup.direction}
            {setup.counterTrend && <span className="counter-tag">COUNTER-TREND</span>}
          </b>
          <span>
            {setup.entryModel.replace(/_/g, " ")} · {setup.timeframe} · {time(setup.createdAt)}
          </span>
        </div>
        <div className="setup-score">
          <strong>{setup.score}</strong>
          <small>/100</small>
        </div>
      </header>

      <div className="setup-levels">
        <div><span>Entry</span><b>{num(setup.entry)}</b></div>
        <div><span>Stop loss</span><b className="bad">{num(setup.stopLoss)}</b></div>
        {setup.takeProfits.map((tp, i) => (
          <div key={i}><span>TP{i + 1}</span><b className="good">{num(tp)}</b></div>
        ))}
        <div>
          <span>R:R</span>
          <b>{setup.rr.length ? setup.rr.map((r) => `1:${num(r, 1)}`).join(" / ") : "—"}</b>
        </div>
        {setup.positionSize != null && (
          <div><span>Size</span><b>{num(setup.positionSize, 6)}</b></div>
        )}
        {setup.riskPct != null && (
          <div><span>Risk</span><b>{num(setup.riskPct, 2)}%</b></div>
        )}
      </div>

      <div className={`status-pill ${executed ? "ok" : rejected ? "bad" : "wait"}`}>
        {setup.status}
      </div>

      <button className="link-button" onClick={() => setOpen(!open)}>
        {open ? "Hide analysis" : "View analysis"} →
      </button>

      {open && (
        <div className="setup-detail">
          {setup.stopLossReason && (
            <p className="why"><b>Stop loss:</b> {setup.stopLossReason}</p>
          )}
          {setup.takeProfitReasons?.map((reason, i) => (
            <p className="why" key={i}><b>TP{i + 1}:</b> {reason}</p>
          ))}
          <SetupReasoning setup={setup} />
          {setup.strategyVersion && (
            <small className="version">Strategy version {setup.strategyVersion}</small>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * §54 — every opportunity the engine saw and did not trade, with the reason.
 * This is what shows the user the system is working rather than idle.
 */
export function RejectedSetups({ setups }: { setups: Setup[] }) {
  const [filter, setFilter] = useState("");
  const rejected = setups.filter(
    (s) => s.status === "REJECTED" || s.status === "INVALIDATED" || s.status === "STALE",
  );
  const shown = filter
    ? rejected.filter((s) =>
        `${s.symbol ?? ""} ${s.direction} ${s.entryModel} ${s.rejectionReasons.join(" ")}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
      )
    : rejected;

  if (rejected.length === 0) {
    return (
      <div className="empty">
        No rejected setups yet.
        <p>
          When the engine declines an opportunity, the reason appears here — RR below the
          minimum, unclear higher-timeframe bias, a risk limit, and so on.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="inline-form">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by market, model or reason"
        />
      </div>
      <div className="market-table">
        <div className="table-row heading rejected-row">
          <span>Time</span>
          <span>Market</span>
          <span>Setup</span>
          <span>Score</span>
          <span>Reason</span>
        </div>
        {shown.map((setup) => (
          <div className="table-row rejected-row" key={setup.id}>
            <span>{time(setup.createdAt)}</span>
            <b>
              {setup.symbol ?? "—"} <small>{setup.direction}</small>
            </b>
            <span>{setup.entryModel.replace(/_/g, " ")}</span>
            <span>{setup.score}</span>
            <span className="reason-cell">
              {setup.rejectionReasons[0] ?? setup.status}
              {setup.rejectionReasons.length > 1 && (
                <small> +{setup.rejectionReasons.length - 1} more</small>
              )}
            </span>
          </div>
        ))}
        {shown.length === 0 && <div className="empty">Nothing matches that filter.</div>}
      </div>
    </>
  );
}
