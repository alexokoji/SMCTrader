import { useCallback, useEffect, useState } from "react";
import { api, type AuthUser } from "./api";
import {
  agentsApi,
  type AgentSnapshot,
  type AgentTrade,
  type MarketCondition,
  type LiveStatus,
  type NewsResult,
  type Portfolio,
  type SpotSignal,
  type CexMarketStat,
} from "./agents-api";
import { MarketPicker } from "./components/MarketPicker";
import { LiveStatusPanel } from "./components/LiveStatus";
import { SpotView } from "./components/SpotView";
import { DeFiView } from "./components/DeFiView";
import {
  defiApi,
  type ChainId,
  type DeFiActivityEvent,
  type DeFiAutoConfig,
  type DeFiPosition,
  type DeFiSignal,
  type ScoutCandidate,
} from "./defi-api";
import {
  AgentsView,
  ConditionsView,
  NewsView,
  PortfolioView,
  TradesView,
  money,
} from "./components/AgentViews";

type Page = "agents" | "spot" | "defi" | "portfolio" | "trades" | "conditions" | "news";
type Theme = "dark" | "light";

/**
 * The theme is applied to the document root so CSS tokens switch wholesale.
 * Dark is the default; a stored choice wins over it. Storage can throw in a
 * private window, so every access is guarded and falls back to the default.
 */
function readStoredTheme(): Theme {
  try {
    return localStorage.getItem("smc-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const nav: Array<[Page, string, string]> = [
  ["agents", "◉", "Agents"],
  ["spot", "◈", "Spot signals"],
  ["defi", "⬡", "DeFi spot"],
  ["portfolio", "◫", "Portfolio"],
  ["trades", "▤", "Trades"],
  ["conditions", "⌁", "Market conditions"],
  ["news", "✽", "News"],
];

const ENTRY_MODELS = ["CONFIRMATION", "SWEEP", "AGGRESSIVE", "COUNTER_TREND"];

function PageTitle({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="page-title">
      <div>
        <p className="eyebrow">SMART MONEY AGENTS</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function App() {
  const [page, setPage] = useState<Page>("agents");
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });

  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [capital, setCapital] = useState({ total: 0, committed: 0 });
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [trades, setTrades] = useState<AgentTrade[]>([]);
  const [conditions, setConditions] = useState<{ conditions: MarketCondition[]; updatedAt: number | null }>({
    conditions: [],
    updatedAt: null,
  });
  const [news, setNews] = useState<NewsResult | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [spotSignals, setSpotSignals] = useState<{ signals: SpotSignal[]; updatedAt: number | null }>({
    signals: [],
    updatedAt: null,
  });
  const [spotCandidates, setSpotCandidates] = useState<{ markets: CexMarketStat[]; updatedAt: number | null }>({
    markets: [],
    updatedAt: null,
  });
  const [spotPinned, setSpotPinned] = useState<string[]>([]);

  const [defiCandidates, setDefiCandidates] = useState<{ candidates: ScoutCandidate[]; updatedAt: number | null; chainErrors: { chain: ChainId; reason: string }[] }>({
    candidates: [],
    updatedAt: null,
    chainErrors: [],
  });
  const [defiSaved, setDefiSaved] = useState<string[]>([]);
  const [defiSignals, setDefiSignals] = useState<{ signals: DeFiSignal[]; updatedAt: number | null }>({ signals: [], updatedAt: null });
  const [defiWallet, setDefiWallet] = useState<string | null>(null);
  const [defiAutoConfig, setDefiAutoConfigState] = useState<DeFiAutoConfig | null>(null);
  const [defiPositions, setDefiPositions] = useState<DeFiPosition[]>([]);
  const [defiActivity, setDefiActivity] = useState<DeFiActivityEvent[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: "",
    mode: "PAPER" as "PAPER" | "LIVE",
    allocatedCapital: "1000",
    symbols: ["BTCUSDT", "ETHUSDT"] as string[],
    entryModels: ["CONFIRMATION", "SWEEP"] as string[],
    riskPerTrade: "1",
    minRr: "3",
  });
  const [capitalInput, setCapitalInput] = useState("");
  const [markets, setMarkets] = useState<string[]>([]);
  const [marketsError, setMarketsError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [agentList, portfolioResult, tradeResult, liveResult] = await Promise.all([
        agentsApi.list(),
        agentsApi.portfolio(),
        agentsApi.trades(),
        agentsApi.liveStatus(),
      ]);
      setAgents(agentList.agents);
      setCapital(agentList.capital);
      setPortfolio(portfolioResult);
      setTrades(tradeResult.trades);
      setLive(liveResult);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("smc-theme", theme);
    } catch {
      // A rejected write only costs the preference, not the theme itself.
    }
  }, [theme]);

  useEffect(() => {
    void api.auth
      .me()
      .then((result) => setUser(result.user))
      .catch((err) => setError(err instanceof Error ? err.message : "Authentication is unavailable."))
      .finally(() => setAuthReady(true));
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [user, refresh]);

  // Markets are only needed to build a new agent; the spot page discovers
  // its own markets and never uses this list.
  useEffect(() => {
    if (!user || !showCreate || markets.length > 0) return;
    void agentsApi
      .markets()
      .then((result) => {
        setMarkets(result.symbols);
        setMarketsError(result.error ?? (result.symbols.length ? null : "No markets returned."));
      })
      .catch((err) => setMarketsError(err instanceof Error ? err.message : String(err)));
  }, [user, showCreate, markets.length]);

  // Spot signals and the underlying discovery are polled only while the page
  // is open, on the same cadence as the engine's own tick, so the analysis on
  // screen is never far behind what the worker last computed.
  useEffect(() => {
    if (!user || page !== "spot") return;
    const load = () => {
      void agentsApi.spotSignals().then(setSpotSignals).catch(() => undefined);
      void agentsApi.spotCandidates().then(setSpotCandidates).catch(() => undefined);
      void agentsApi.spotPinned().then((r) => setSpotPinned(r.pinned)).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 20_000);
    return () => clearInterval(timer);
  }, [user, page]);

  const pinSpotMarket = (symbol: string) =>
    void run("spot-pin", async () => {
      const result = await agentsApi.pinSpotMarket(symbol);
      if (result.error) throw new Error(result.error);
      setSpotPinned(result.pinned);
      setSpotSignals(await agentsApi.spotSignals());
    });

  const unpinSpotMarket = (symbol: string) =>
    void run("spot-unpin", async () => {
      const result = await agentsApi.unpinSpotMarket(symbol);
      setSpotPinned(result.pinned);
    });

  const rescoutSpot = () =>
    void run("spot-rescout", async () => {
      await agentsApi.rescoutSpot();
      setSpotCandidates(await agentsApi.spotCandidates());
      setSpotSignals(await agentsApi.spotSignals());
    });

  // DeFi: discovery and saved-pool analysis are polled only while the page is
  // open. Wallet, config, positions and activity are cheap and loaded once
  // the page opens, then refreshed on the same interval.
  useEffect(() => {
    if (!user || page !== "defi") return;
    const load = () => {
      void defiApi.candidates().then(setDefiCandidates).catch(() => undefined);
      void defiApi.saved().then((r) => setDefiSaved(r.saved)).catch(() => undefined);
      void defiApi.signals().then(setDefiSignals).catch(() => undefined);
      void defiApi.walletAddress().then((r) => setDefiWallet(r.address)).catch(() => undefined);
      void defiApi.autoConfig().then(setDefiAutoConfigState).catch(() => undefined);
      void defiApi.positions().then((r) => setDefiPositions(r.positions)).catch(() => undefined);
      void defiApi.activity().then((r) => setDefiActivity(r.activity)).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [user, page]);

  const saveDefiPool = (symbol: string) =>
    void run("defi-save", async () => {
      const result = await defiApi.save(symbol);
      if (result.error) throw new Error(result.error);
      setDefiSaved(result.saved);
      setDefiSignals(await defiApi.signals());
    });

  const unsaveDefiPool = (symbol: string) =>
    void run("defi-unsave", async () => {
      const result = await defiApi.unsave(symbol);
      setDefiSaved(result.saved);
    });

  const rescoutDefi = () =>
    void run("defi-rescout", async () => {
      await defiApi.rescout();
      setDefiCandidates(await defiApi.candidates());
    });

  const createDefiWallet = async () => {
    const result = await defiApi.createWallet();
    if (!("error" in result)) {
      setDefiWallet(result.address);
      setDefiAutoConfigState(await defiApi.autoConfig());
      setNotice("Wallet created. Save the private key shown — it will not be shown again.");
    } else {
      setError(result.error);
    }
    return result;
  };

  const importDefiWallet = (privateKey: string) =>
    void run("defi-import-wallet", async () => {
      const result = await defiApi.importWallet(privateKey);
      if (result.error) throw new Error(result.error);
      setDefiWallet(result.address);
      setDefiAutoConfigState(await defiApi.autoConfig());
      setNotice("Wallet imported.");
    });

  const removeDefiWallet = () =>
    void run("defi-remove-wallet", async () => {
      await defiApi.removeWallet();
      setDefiWallet(null);
      setDefiAutoConfigState(await defiApi.autoConfig());
      setNotice("Wallet removed. Automated trading is disabled.");
    });

  const saveDefiAutoConfig = (patch: Partial<DeFiAutoConfig>) =>
    void run("defi-auto-config", async () => {
      const result = await defiApi.setAutoConfig(patch);
      if (result.error) throw new Error(result.error);
      setDefiAutoConfigState(result.config);
      setNotice("Automated trading settings saved.");
    });

  useEffect(() => {
    if (!user || page !== "conditions") return;
    void agentsApi.conditions().then(setConditions).catch(() => undefined);
  }, [user, page]);

  useEffect(() => {
    if (!user || page !== "news") return;
    void agentsApi.news().then(setNews).catch(() => undefined);
  }, [user, page]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const createAgent = () =>
    void run("create", async () => {
      if (form.symbols.length === 0) throw new Error("Select at least one market for the agent.");
      const result = await agentsApi.create({
        name: form.name.trim() || "Agent",
        mode: form.mode,
        allocatedCapital: Number(form.allocatedCapital),
        symbols: form.symbols,
        entryModels: form.entryModels,
        riskPerTrade: Number(form.riskPerTrade),
        minRr: Number(form.minRr),
      });
      if (result.error) throw new Error(result.error);
      setShowCreate(false);
      setNotice(`Agent "${result.agent?.name}" created and funded.`);
    });

  const updateAgent = (id: string, patch: Record<string, unknown>) =>
    void run(id, async () => {
      const result = await agentsApi.update(id, patch as never);
      if (result.error) throw new Error(result.error);
    });

  const removeAgent = (id: string) => void run(id, () => agentsApi.remove(id));

  const saveCapital = () =>
    void run("capital", async () => {
      const amount = Number(capitalInput);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a capital amount greater than zero.");
      await agentsApi.setCapital(amount);
      setCapitalInput("");
      setNotice("Paper capital updated.");
    });

  const signIn = (register: boolean) =>
    void run("auth", async () => {
      const result = register
        ? await api.auth.register(authForm.email, authForm.password, authForm.name)
        : await api.auth.login(authForm.email, authForm.password);
      setUser(result.user);
    });

  if (!authReady) {
    return <div className="auth-shell"><main><div className="empty">Checking secure session…</div></main></div>;
  }

  if (!user) {
    return (
      <div className="auth-shell">
        <main>
          <div className="page-title">
            <div>
              <p className="eyebrow">SMART MONEY AGENTS</p>
              <h1>Sign in</h1>
              <p>Your agents, capital and trade history stay private to your account.</p>
            </div>
          </div>
          <section className="card">
            <div className="card-head"><h2>Email and password</h2></div>
            <div className="form-grid">
              <label>Name (registration)
                <input value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })}/>
              </label>
              <label>Email
                <input type="email" value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })}/>
              </label>
              <label>Password
                <input type="password" minLength={12} value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}/>
              </label>
            </div>
            <div className="card-actions">
              <button className="primary" disabled={busy === "auth"} onClick={() => signIn(false)}>Sign in</button>
              <button disabled={busy === "auth"} onClick={() => signIn(true)}>Create account</button>
              <button onClick={() => api.auth.google()}>Continue with Google</button>
            </div>
            {error && <p className="helper bad">{error}</p>}
            <p className="helper">Passwords require at least 12 characters.</p>
          </section>
        </main>
      </div>
    );
  }

  const createPanel = showCreate && (
    <section className="card">
      <div className="card-head"><h2>New agent</h2></div>
      <div className="form-grid">
        <label>Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Trend follower"/>
        </label>
        <label>Mode
          <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "PAPER" | "LIVE" })}>
            <option value="PAPER">Paper</option>
            <option value="LIVE" disabled>Live (not enabled on this deployment)</option>
          </select>
        </label>
        <label>Capital to assign
          <input value={form.allocatedCapital} onChange={(e) => setForm({ ...form, allocatedCapital: e.target.value })}/>
        </label>
        <label>Risk per trade (%)
          <input value={form.riskPerTrade} onChange={(e) => setForm({ ...form, riskPerTrade: e.target.value })}/>
        </label>
        <label>Minimum R:R
          <input value={form.minRr} onChange={(e) => setForm({ ...form, minRr: e.target.value })}/>
        </label>
      </div>
      <MarketPicker
        available={markets}
        selected={form.symbols}
        error={marketsError}
        onChange={(symbols) => setForm({ ...form, symbols })}
      />
      <h4 className="field-label">Entry models</h4>
      <div className="layer-toggles">
        {ENTRY_MODELS.map((model) => (
          <label key={model} className={form.entryModels.includes(model) ? "on" : ""}>
            <input
              type="checkbox"
              checked={form.entryModels.includes(model)}
              onChange={(e) =>
                setForm({
                  ...form,
                  entryModels: e.target.checked
                    ? [...form.entryModels, model]
                    : form.entryModels.filter((m) => m !== model),
                })
              }
            />
            {model.replace(/_/g, " ")}
          </label>
        ))}
      </div>
      <p className="helper">
        {money(Math.max(0, capital.total - capital.committed))} is free to allocate.
      </p>
      <div className="card-actions">
        <button className="primary" disabled={busy === "create"} onClick={createAgent}>
          {busy === "create" ? "Creating…" : "Create and fund"}
        </button>
        <button onClick={() => setShowCreate(false)}>Cancel</button>
      </div>
    </section>
  );

  const pages: Record<Page, React.ReactNode> = {
    agents: (
      <>
        <PageTitle
          title="Agents"
          description="Each agent trades its own capital on its own markets, and is supervised independently."
          action={
            <button className="primary" onClick={() => setShowCreate(!showCreate)}>
              {showCreate ? "Close" : "New agent"}
            </button>
          }
        />
        {createPanel}
        <LiveStatusPanel status={live}/>
        <section className="card">
          <div className="card-head"><h2>Paper capital</h2></div>
          <p className="helper">
            Paper capital is the pool agents draw allocations from. Live capital would come
            from a connected exchange balance; live trading is not enabled on this
            deployment, so no exchange balance is reported.
          </p>
          <div className="inline-form">
            <input
              value={capitalInput}
              onChange={(e) => setCapitalInput(e.target.value)}
              placeholder={String(capital.total)}
            />
            <button disabled={busy === "capital"} onClick={saveCapital}>Set pool</button>
          </div>
        </section>
        <AgentsView agents={agents} capital={capital} onUpdate={updateAgent} onRemove={removeAgent} busy={busy}/>
      </>
    ),
    spot: (
      <>
        <PageTitle
          title="Spot signals"
          description="Continuous read-only analysis of markets you choose — no capital, no agent, no order placed for you."
        />
        <SpotView
          signals={spotSignals.signals}
          updatedAt={spotSignals.updatedAt}
          candidates={spotCandidates.markets}
          candidatesUpdatedAt={spotCandidates.updatedAt}
          pinned={spotPinned}
          onPin={pinSpotMarket}
          onUnpin={unpinSpotMarket}
          onRescout={rescoutSpot}
          busy={busy?.startsWith("spot-") ?? false}
        />
      </>
    ),
    defi: (
      <>
        <PageTitle
          title="DeFi spot"
          description="On-chain pools, discovered across every registered chain — save what you want to follow, or let the automated bot trade within its own limits."
        />
        {defiAutoConfig && (
          <DeFiView
            candidates={defiCandidates.candidates}
            candidatesUpdatedAt={defiCandidates.updatedAt}
            chainErrors={defiCandidates.chainErrors}
            saved={defiSaved}
            signals={defiSignals.signals}
            signalsUpdatedAt={defiSignals.updatedAt}
            onSave={saveDefiPool}
            onUnsave={unsaveDefiPool}
            onRescout={rescoutDefi}
            walletAddress={defiWallet}
            onCreateWallet={createDefiWallet}
            onImportWallet={importDefiWallet}
            onRemoveWallet={removeDefiWallet}
            autoConfig={defiAutoConfig}
            onSaveAutoConfig={saveDefiAutoConfig}
            positions={defiPositions}
            activity={defiActivity}
            busy={busy?.startsWith("defi") ?? false}
          />
        )}
      </>
    ),
    portfolio: (
      <>
        <PageTitle title="Portfolio" description="Capital, equity and realised results across every agent." />
        <PortfolioView portfolio={portfolio}/>
      </>
    ),
    trades: (
      <>
        <PageTitle title="Trades" description="Every position an agent has opened, with how it was closed." />
        <TradesView trades={trades}/>
      </>
    ),
    conditions: (
      <>
        <PageTitle title="Market conditions" description="How each market is behaving, classified from structure and directional efficiency." />
        <ConditionsView conditions={conditions.conditions} updatedAt={conditions.updatedAt}/>
      </>
    ),
    news: (
      <>
        <PageTitle title="Crypto news" description="Headlines that bear on the markets your agents trade." />
        <NewsView news={news}/>
      </>
    ),
  };

  const activeLabel = nav.find(([id]) => id === page)?.[2] ?? "Agents";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span>m</span>
          <div><b>Mirage</b><small>SMART MONEY AGENTS</small></div>
        </div>
        <nav>
          {nav.map(([id, icon, label]) => (
            <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}>
              <i>{icon}</i>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button
            className="theme-toggle"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "☾ Dark" : "☀ Light"}
          </button>
          <span>{user.email}</span>
          <button className="link-button" onClick={() => void api.auth.logout().then(() => setUser(null))}>
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <header className="mobile-head">
          <button className="brand-mobile" onClick={() => setPage("agents")}>m</button>
          <span>{activeLabel}</span>
          <button
            className="theme-toggle"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </header>
        {error && (
          <div className="alert error">
            <b>Action required</b>{error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {notice && (
          <div className="alert success">
            <b>Done</b>{notice}
            <button onClick={() => setNotice(null)}>×</button>
          </div>
        )}
        {pages[page]}
      </main>
      <nav className="mobile-nav" aria-label="Primary">
        {nav.map(([id, icon, label]) => (
          <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}>
            <i>{icon}</i>
            <span>{label.split(" ")[0]}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export { App };
