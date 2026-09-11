import { useState } from "react";
import type {
  ChainId,
  DeFiActivityEvent,
  DeFiAutoConfig,
  DeFiPosition,
  DeFiSignal,
  ScoutCandidate,
} from "../defi-api";
import { num } from "./AgentViews";

/**
 * DeFi spot — discovered, not typed in.
 *
 * Every pool on this page came from scouting every registered chain, never
 * from a form field. Saving one only bookmarks it for the full analysis
 * engine to keep watching; the automated bot below never needs anything
 * saved — it scouts and trades entirely on its own, inside the limits set
 * here.
 */

function ago(ts?: number | null): string {
  if (!ts) return "never";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function priceOf(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : 8;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const CHAIN_LABEL: Record<ChainId, string> = {
  ethereum: "Ethereum",
  bsc: "BNB Chain",
  polygon: "Polygon",
  arbitrum: "Arbitrum",
  base: "Base",
};

function ChainBadge({ chain, dex }: { chain: ChainId; dex: string }) {
  return (
    <span className="chain-badge">
      {CHAIN_LABEL[chain] ?? chain} · {dex.replace(/_/g, " ")}
    </span>
  );
}

function CandidateRow({ candidate, saved, onSave }: { candidate: ScoutCandidate; saved: boolean; onSave: (symbol: string) => void }) {
  return (
    <div className="defi-candidate">
      <div className="defi-candidate-main">
        <b>{candidate.baseSymbol}</b>
        <ChainBadge chain={candidate.network} dex={candidate.dex} />
        <span className="chain-badge" title={candidate.source === "dexscreener" ? "Found via a boosted/submitted listing, then verified against the same safety filters" : "Found by organic trading-activity ranking"}>
          {candidate.source === "dexscreener" ? "dexscreener" : "geckoterminal"}
        </span>
        {candidate.fromNews && <span className="chain-badge" title="Named in a recent headline, then verified against the same safety filters">in the news</span>}
      </div>
      <div className="defi-candidate-meta">
        <span>{priceOf(candidate.priceUsd)}</span>
        <span>Liq {usd(candidate.liquidityUsd)}</span>
        <span>Vol {usd(candidate.volumeUsd24h)}</span>
        <span className={candidate.priceChangePct24h >= 0 ? "good" : "bad"}>
          {candidate.priceChangePct24h >= 0 ? "+" : ""}{num(candidate.priceChangePct24h, 1)}% 24h
        </span>
      </div>
      <button disabled={saved} onClick={() => onSave(candidate.symbol)}>
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  );
}

function SignalCard({ signal, onUnsave }: { signal: DeFiSignal; onUnsave: (symbol: string) => void }) {
  const setup = signal.setup;
  return (
    <article className="spot-card">
      <header>
        <b>{signal.baseSymbol}</b>
        <div className="spot-card-pills">
          <ChainBadge chain={signal.network} dex={signal.dex} />
          <button className="link-button" onClick={() => onUnsave(signal.symbol)}>Remove</button>
        </div>
      </header>
      <div className="spot-price-row">
        <span>{priceOf(signal.price)}</span>
        <span className="helper">updated {ago(signal.updatedAt)}</span>
      </div>
      <div className="defi-candidate-meta">
        <span>Liq {usd(signal.liquidityUsd)}</span>
        <span>Vol {usd(signal.volumeUsd24h)}</span>
        {signal.fdvUsd !== null && <span>FDV {usd(signal.fdvUsd)}</span>}
      </div>
      {signal.warming ? (
        <p className="helper">Still loading history for this pool — not authoritative yet.</p>
      ) : setup ? (
        <div className="spot-setup">
          <header>
            <span className={`status-pill ${setup.direction === "LONG" ? "ok" : "bad"}`}>
              {setup.direction === "LONG" ? "BUY" : "SELL"}
            </span>
            <b className={setup.nearestTargetPct >= 0 ? "good" : "bad"}>
              {setup.nearestTargetPct >= 0 ? "+" : ""}{num(setup.nearestTargetPct, 1)}% to nearest target
            </b>
            <span className="spot-score">Score {Math.round(setup.score)}</span>
          </header>
          <div className="spot-levels">
            <div><span>Entry</span><b>{priceOf(setup.entry)}</b></div>
            <div><span>Stop</span><b>{priceOf(setup.stopLoss)}</b></div>
            <div><span>R:R</span><b>{setup.rr.map((r) => `1:${num(r, 1)}`).join(" / ")}</b></div>
          </div>
          <p className="helper">{setup.reasons.slice(0, 2).join(" ")}</p>
        </div>
      ) : (
        <p className="helper">{signal.noTradeReason ?? "Analysed, nothing tradeable right now."}</p>
      )}
    </article>
  );
}

function WalletPanel({
  address,
  onCreate,
  onImport,
  onRemove,
  busy,
}: {
  address: string | null;
  onCreate: () => Promise<{ address: string; privateKey: string } | { error: string }>;
  onImport: (key: string) => void;
  onRemove: () => void;
  busy?: boolean;
}) {
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [importKey, setImportKey] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  if (revealedKey) {
    return (
      <div className="alert warn">
        <b>Save this now</b>
        <p>
          This private key will not be shown again. Anyone who has it controls this wallet and
          everything in it.
        </p>
        <code className="defi-key-reveal">{revealedKey}</code>
        <button className="primary" onClick={() => setRevealedKey(null)}>I've saved it</button>
      </div>
    );
  }

  if (address) {
    return (
      <div className="defi-wallet">
        <div>
          <span className="helper">Bot wallet</span>
          <code>{address}</code>
        </div>
        {confirmingRemove ? (
          <div className="card-actions">
            <span className="helper bad">This disables automated trading. Fund is not moved — only the key stored here is removed.</span>
            <button onClick={() => { onRemove(); setConfirmingRemove(false); }}>Confirm remove</button>
            <button onClick={() => setConfirmingRemove(false)}>Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirmingRemove(true)}>Remove wallet</button>
        )}
      </div>
    );
  }

  return (
    <div className="defi-wallet-setup">
      <button
        className="primary"
        disabled={busy}
        onClick={async () => {
          const result = await onCreate();
          if ("privateKey" in result) setRevealedKey(result.privateKey);
        }}
      >
        Generate a new wallet
      </button>
      <div className="inline-form">
        <input
          value={importKey}
          onChange={(e) => setImportKey(e.target.value)}
          placeholder="Or paste an existing private key (0x...)"
          type="password"
        />
        <button disabled={busy || !importKey} onClick={() => { onImport(importKey); setImportKey(""); }}>
          Import
        </button>
      </div>
      <p className="helper">
        The key is encrypted at rest and used only to sign the swaps this bot executes. It is
        never shown again after you generate or import it.
      </p>
    </div>
  );
}

function PositionRow({ position }: { position: DeFiPosition }) {
  return (
    <div className={`defi-position ${position.status === "CLOSED" ? "closed" : ""}`}>
      <div className="defi-candidate-main">
        <b>{position.baseSymbol}</b>
        <ChainBadge chain={position.network} dex={position.dex} />
        <span className={`status-pill ${position.status === "OPEN" ? "ok" : "wait"}`}>{position.status}</span>
      </div>
      <div className="defi-candidate-meta">
        <span>Entry {priceOf(position.entryPriceUsd)}</span>
        <span>${position.amountInUsd.toFixed(0)} in</span>
        {position.status === "CLOSED" && position.realizedPnlUsd !== undefined && (
          <span className={position.realizedPnlUsd >= 0 ? "good" : "bad"}>
            {position.realizedPnlUsd >= 0 ? "+" : ""}${position.realizedPnlUsd.toFixed(2)}
          </span>
        )}
      </div>
      {position.closeReason && <p className="helper">{position.closeReason}</p>}
    </div>
  );
}

export function DeFiView({
  candidates,
  candidatesUpdatedAt,
  chainErrors,
  sourceErrors,
  saved,
  signals,
  signalsUpdatedAt,
  onSave,
  onUnsave,
  onRescout,
  walletAddress,
  onCreateWallet,
  onImportWallet,
  onRemoveWallet,
  autoConfig,
  onSaveAutoConfig,
  positions,
  activity,
  busy,
}: {
  candidates: ScoutCandidate[];
  candidatesUpdatedAt: number | null;
  chainErrors: { chain: ChainId; reason: string }[];
  sourceErrors: { source: string; reason: string }[];
  saved: string[];
  signals: DeFiSignal[];
  signalsUpdatedAt: number | null;
  onSave: (symbol: string) => void;
  onUnsave: (symbol: string) => void;
  onRescout: () => void;
  walletAddress: string | null;
  onCreateWallet: () => Promise<{ address: string; privateKey: string } | { error: string }>;
  onImportWallet: (key: string) => void;
  onRemoveWallet: () => void;
  autoConfig: DeFiAutoConfig;
  onSaveAutoConfig: (patch: Partial<DeFiAutoConfig>) => void;
  positions: DeFiPosition[];
  activity: DeFiActivityEvent[];
  busy?: boolean;
}) {
  const [configDraft, setConfigDraft] = useState<Partial<DeFiAutoConfig>>({});
  const draft = { ...autoConfig, ...configDraft };
  const open = positions.filter((p) => p.status === "OPEN");
  const closed = positions.filter((p) => p.status === "CLOSED").slice(0, 20);

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Scouted markets</h2>
          <button onClick={onRescout}>Re-scout now</button>
        </div>
        <p className="helper">
          Swept from GeckoTerminal and DexScreener across every registered chain {ago(candidatesUpdatedAt)}
          — nothing here was typed in. Save any pool to keep the full analysis engine watching it below.
        </p>
        {chainErrors.length > 0 && (
          <p className="helper bad">
            GeckoTerminal unreachable: {chainErrors.map((e) => `${e.chain} (${e.reason})`).join(", ")}
            {sourceErrors.length === 0 && " — DexScreener candidates below still came through."}
          </p>
        )}
        {sourceErrors.length > 0 && (
          <p className="helper bad">
            DexScreener unreachable: {sourceErrors.map((e) => `${e.source} (${e.reason})`).join(", ")}
          </p>
        )}
        {candidates.length === 0 ? (
          <div className="empty">No candidates cleared the safety filters on the last scout.</div>
        ) : (
          <div className="defi-candidate-list">
            {candidates.map((c) => (
              <CandidateRow key={c.symbol} candidate={c} saved={saved.includes(c.symbol)} onSave={onSave} />
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h2>Saved — full analysis</h2></div>
        <p className="helper">Last analysed {ago(signalsUpdatedAt)}. This page never places an order.</p>
        {signals.length === 0 ? (
          <div className="empty">Nothing saved yet. Save a scouted pool above to start analysing it.</div>
        ) : (
          <div className="spot-grid">
            {signals.map((s) => <SignalCard key={s.symbol} signal={s} onUnsave={onUnsave} />)}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h2>Automated trading</h2></div>
        <p className="helper">
          Fully automatic: it scouts, decides and trades on its own — nothing needs to be saved
          first. A position in profit past the target is sold back to {" "}
          {draft.exitPolicy?.takeProfitPct ?? 15}% and swept to stable; a position at a loss is
          held and watched until it recovers to that same target.
        </p>
        <WalletPanel
          address={walletAddress}
          onCreate={onCreateWallet}
          onImport={onImportWallet}
          onRemove={onRemoveWallet}
          busy={busy}
        />

        <div className="form-grid">
          <label>Enabled
            <select
              value={draft.enabled ? "on" : "off"}
              onChange={(e) => setConfigDraft({ ...configDraft, enabled: e.target.value === "on" })}
              disabled={!walletAddress}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
          <label>Allocated capital (USD)
            <input value={draft.allocatedCapitalUsd} onChange={(e) => setConfigDraft({ ...configDraft, allocatedCapitalUsd: Number(e.target.value) })} />
          </label>
          <label>Per-trade cap (USD)
            <input value={draft.perTradeCapUsd} onChange={(e) => setConfigDraft({ ...configDraft, perTradeCapUsd: Number(e.target.value) })} />
          </label>
          <label>Take-profit target (%)
            <input
              value={draft.exitPolicy?.takeProfitPct ?? 15}
              onChange={(e) => setConfigDraft({ ...configDraft, exitPolicy: { ...draft.exitPolicy, takeProfitPct: Number(e.target.value) } })}
            />
          </label>
          <label>Max gas price (gwei)
            <input value={draft.maxGasPriceGwei} onChange={(e) => setConfigDraft({ ...configDraft, maxGasPriceGwei: Number(e.target.value) })} />
          </label>
          <label>Slippage tolerance (bps)
            <input value={draft.slippageBps} onChange={(e) => setConfigDraft({ ...configDraft, slippageBps: Number(e.target.value) })} />
          </label>
          <label>Minimum score
            <input value={draft.minScore} onChange={(e) => setConfigDraft({ ...configDraft, minScore: Number(e.target.value) })} />
          </label>
        </div>
        <div className="card-actions">
          <button className="primary" disabled={busy} onClick={() => { onSaveAutoConfig(configDraft); setConfigDraft({}); }}>
            Save settings
          </button>
        </div>

        {open.length > 0 && (
          <>
            <h4 className="field-label">Open positions</h4>
            <div className="defi-position-list">
              {open.map((p) => <PositionRow key={p.id} position={p} />)}
            </div>
          </>
        )}
        {closed.length > 0 && (
          <>
            <h4 className="field-label">Recently closed</h4>
            <div className="defi-position-list">
              {closed.map((p) => <PositionRow key={p.id} position={p} />)}
            </div>
          </>
        )}
        {activity.length > 0 && (
          <>
            <h4 className="field-label">Activity</h4>
            <div className="defi-activity-list">
              {activity.slice(0, 15).map((e, i) => (
                <p key={i} className={`helper ${e.level === "danger" ? "bad" : ""}`}>
                  <span className="defi-activity-time">{ago(e.timestamp)}</span> {e.detail}
                </p>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}
