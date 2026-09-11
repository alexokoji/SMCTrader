import type { CexMarketStat, SpotSignal, SpotSetupView } from "../agents-api";
import { num } from "./AgentViews";

/**
 * Spot signals.
 *
 * This is analysis, not an agent: nothing here places an order. What gets
 * analysed is discovered, not typed in — the top USDT pairs by 24h volume are
 * pulled fresh every tick and shown automatically; pinning a market only adds
 * it to that list regardless of its ranking, it is never required to see
 * anything. Every card states what the engine concluded and why, at what
 * price it would matter, and what move it implies — so a trader can act on
 * their own exchange account, or not, on their own judgement.
 */

function ago(ts?: number | null): string {
  if (!ts) return "never";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

const REGIME_TONE: Record<string, string> = {
  TRENDING_UP: "ok",
  TRENDING_DOWN: "bad",
  RANGING: "wait",
  VOLATILE: "warn",
  QUIET: "wait",
  UNKNOWN: "wait",
};

const BIAS_TONE: Record<string, string> = {
  BULLISH: "ok",
  BEARISH: "bad",
  NEUTRAL: "wait",
  UNCLEAR: "wait",
};

function directionLabel(direction: string): string {
  return direction === "LONG" ? "BUY" : direction === "SHORT" ? "SELL" : direction;
}

function priceOf(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function SetupCard({ setup, muted = false }: { setup: SpotSetupView; muted?: boolean }) {
  const long = setup.direction === "LONG";
  return (
    <div className={`spot-setup ${muted ? "muted" : ""}`}>
      <header>
        <span className={`status-pill ${long ? "ok" : "bad"}`}>{directionLabel(setup.direction)}</span>
        <b className={setup.nearestTargetPct >= 0 ? "good" : "bad"}>
          {setup.nearestTargetPct >= 0 ? "+" : ""}{num(setup.nearestTargetPct, 1)}% to nearest target
        </b>
        <span className="spot-score">Score {Math.round(setup.score)}</span>
      </header>
      <div className="spot-levels">
        <div><span>Entry</span><b>{priceOf(setup.entry)}</b></div>
        <div><span>Stop</span><b>{priceOf(setup.stopLoss)}</b></div>
        <div>
          <span>Targets</span>
          <b>
            {setup.takeProfits.map((tp, i) => (
              <span key={i} className="spot-target">
                {priceOf(tp)} <em className={setup.targetMovesPct[i]! >= 0 ? "good" : "bad"}>
                  ({setup.targetMovesPct[i]! >= 0 ? "+" : ""}{num(setup.targetMovesPct[i], 1)}%)
                </em>
              </span>
            ))}
          </b>
        </div>
        <div><span>R:R</span><b>{setup.rr.map((r) => `1:${num(r, 1)}`).join(" / ")}</b></div>
      </div>
      <p className="helper">
        {setup.entryModel.replace(/_/g, " ")} entry on the {setup.timeframe} — {setup.reasons.slice(0, 2).join(" ")}
      </p>
    </div>
  );
}

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function SignalCard({ signal, onPin, onUnpin }: { signal: SpotSignal; onPin: (symbol: string) => void; onUnpin: (symbol: string) => void }) {
  return (
    <article className="spot-card">
      <header>
        <b>{signal.symbol}</b>
        <div className="spot-card-pills">
          <span className={`status-pill ${BIAS_TONE[signal.bias] ?? "wait"}`}>{signal.bias}</span>
          {signal.regime && (
            <span className={`status-pill ${REGIME_TONE[signal.regime] ?? "wait"}`}>
              {signal.regime.replace(/_/g, " ")}
            </span>
          )}
          <button className="link-button" onClick={() => (signal.pinned ? onUnpin(signal.symbol) : onPin(signal.symbol))}>
            {signal.pinned ? "Unpin" : "Pin"}
          </button>
        </div>
      </header>
      <div className="spot-price-row">
        <span>{signal.price !== null ? priceOf(signal.price) : "—"}</span>
        <span className="helper">updated {ago(signal.updatedAt)}</span>
      </div>
      <div className="defi-candidate-meta">
        {signal.volumeUsd24h !== null && <span>Vol {usd(signal.volumeUsd24h)}</span>}
        {signal.priceChangePct24h !== null && (
          <span className={signal.priceChangePct24h >= 0 ? "good" : "bad"}>
            {signal.priceChangePct24h >= 0 ? "+" : ""}{num(signal.priceChangePct24h, 1)}% 24h
          </span>
        )}
        {signal.discovered && !signal.pinned && <span className="chain-badge">discovered</span>}
        {signal.pinned && <span className="chain-badge">pinned</span>}
        {signal.newsSource && <span className="chain-badge" title="Named in a recent headline, then verified as a real, liquid pair">in the news</span>}
      </div>

      {signal.warming ? (
        <p className="helper">Still loading history for this market — not authoritative yet.</p>
      ) : signal.setup ? (
        <SetupCard setup={signal.setup} />
      ) : (
        <p className="helper">{signal.noTradeReason ?? "Analysed, nothing tradeable right now."}</p>
      )}

      {signal.alternates.length > 0 && (
        <details className="spot-alternates">
          <summary>{signal.alternates.length} other valid setup{signal.alternates.length === 1 ? "" : "s"}</summary>
          {signal.alternates.map((alt, i) => <SetupCard key={i} setup={alt} muted />)}
        </details>
      )}

      {signal.news.length > 0 && (
        <div className="spot-news">
          {signal.news.map((item, i) => (
            <a key={i} href={item.url} target="_blank" rel="noreferrer noopener" className={item.sentiment.toLowerCase()}>
              {item.title}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

export function SpotView({
  signals,
  updatedAt,
  candidates,
  candidatesUpdatedAt,
  pinned,
  onPin,
  onUnpin,
  onRescout,
  busy,
}: {
  signals: SpotSignal[];
  updatedAt: number | null;
  candidates: CexMarketStat[];
  candidatesUpdatedAt: number | null;
  pinned: string[];
  onPin: (symbol: string) => void;
  onUnpin: (symbol: string) => void;
  onRescout: () => void;
  busy?: boolean;
}) {
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Discovered markets</h2>
          <button disabled={busy} onClick={onRescout}>Re-scout now</button>
        </div>
        <p className="helper">
          The top {candidates.length} USDT pairs by 24h volume, pulled fresh {ago(candidatesUpdatedAt)} —
          nothing here was typed in. Pin a market below to keep it in view regardless of its ranking.
        </p>
      </section>

      <p className="helper spot-disclaimer">
        This page never places an order. Every card is the same deterministic SMC analysis an
        agent uses, run continuously and read-only — the entry, stop, targets and expected move
        are what the engine would trade if it were allowed to; the decision stays yours.
      </p>

      {signals.length === 0 ? (
        <div className="empty">
          No markets cleared the volume floor on the last scout, and nothing is pinned.
          <p>Try re-scouting, or check back shortly.</p>
        </div>
      ) : (
        <>
          <p className="helper">Analysed {signals.length} market{signals.length === 1 ? "" : "s"} · last analysed {ago(updatedAt)} · {pinned.length} pinned</p>
          <div className="spot-grid">
            {signals.map((signal) => <SignalCard key={signal.symbol} signal={signal} onPin={onPin} onUnpin={onUnpin} />)}
          </div>
        </>
      )}
    </>
  );
}
