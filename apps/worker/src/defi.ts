/**
 * DeFi spot — on-chain trading, discovered rather than typed in.
 *
 * Two independent surfaces share the same discovery and the same engine:
 *
 * - Manual: `discover()` scouts every registered chain and returns candidates
 *   nobody had to type in; the trader saves the ones they want to keep
 *   watching, and only the saved list gets the full analysis engine run on
 *   it every tick — unbounded analysis on the whole scouted universe every
 *   tick is exactly the cost spike that broke production once already for
 *   the CEX spot page (see the `agentsWarming` guard around `tickSpot` in
 *   index.ts).
 * - Automated: no saving, no watching — it scouts, decides, and trades
 *   within its own configured limits on every tick it is enabled for.
 *   Nothing here is paper: every executed swap is a real on-chain
 *   transaction from a wallet this runtime holds the key to. The exit policy
 *   is exactly as specified — profit is swept to stable, a loser is held and
 *   watched until it recovers — see `exit-policy.ts` in `@smc/core` for what
 *   that does and does not do on its own.
 */
import {
  CHAINS,
  DEFAULT_EXIT_POLICY,
  EvmWallet,
  GeckoTerminalClient,
  GeckoTerminalMarketDataProvider,
  Scout,
  addressFromPrivateKey,
  checkGasCap,
  checkTradeCap,
  decideExit,
  decryptSecret,
  encryptSecret,
  generateWallet,
  parsePoolSymbol,
  type ChainId,
  type EvmWalletLike,
  type ExitPolicyConfig,
  type ScoutCandidate,
} from "@smc/core";
import { TradingRuntime, type RuntimeStorage } from "./runtime.js";

const MAX_SAVED_POOLS = 15;
const AUTO_CANDIDATES_PER_TICK = 3;
const ENTRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The automated bot only executes against Uniswap-V2-style routers (see
 * `evm-wallet.ts`), but the scout discovers pools on every AMM design a
 * chain runs, V3/CLMM designs included — the pools with the highest turnover
 * in practice are frequently V3, confirmed by a live discovery run that
 * returned "pancakeswap-v3-bsc" and "pancakeswap-infinity-clmm" among its top
 * results. A V2 router has no route through a pool that only exists as a V3
 * position, so trying anyway either reverts (wasted gas, caught below) or —
 * worse — executes against a thinner, unrelated V2 pool for the same token
 * pair, at a price and depth nothing here validated. The automated entry
 * path filters to dexes this codebase actually knows how to execute against;
 * manual/display mode is unaffected — it never executes anything.
 */
const V2_COMPATIBLE_DEX_IDS = new Set(["uniswap_v2", "pancakeswap", "pancakeswap_v2", "sushiswap", "quickswap"]);

export function isV2Compatible(dex: string): boolean {
  return V2_COMPATIBLE_DEX_IDS.has(dex.toLowerCase()) || /v2/i.test(dex);
}

export interface DeFiSetupView {
  direction: string;
  entryModel: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  targetMovesPct: number[];
  nearestTargetPct: number;
  rr: number[];
  score: number;
  reasons: string[];
  createdAt: number;
}

export interface DeFiSignal {
  symbol: string;
  network: ChainId;
  poolAddress: string;
  dex: string;
  baseSymbol: string;
  quoteSymbol: string;
  price: number | null;
  liquidityUsd: number;
  volumeUsd24h: number;
  fdvUsd: number | null;
  bias: string;
  status: string;
  warming: boolean;
  noTradeReason: string | null;
  setup: DeFiSetupView | null;
  updatedAt: number;
}

export interface DeFiAutoConfig {
  enabled: boolean;
  chains: ChainId[];
  /** Total the bot is allowed to have in open positions at once, in USD. */
  allocatedCapitalUsd: number;
  /** Ceiling on a single trade, in USD — the control that bounds what one
   * bad decision or one compromised key can move in one transaction. */
  perTradeCapUsd: number;
  maxGasPriceGwei: number;
  slippageBps: number;
  minScore: number;
  exitPolicy: ExitPolicyConfig;
  walletAddress: string | null;
}

export const DEFAULT_AUTO_CONFIG: DeFiAutoConfig = {
  enabled: false,
  chains: ["ethereum", "base", "arbitrum"],
  allocatedCapitalUsd: 0,
  perTradeCapUsd: 50,
  maxGasPriceGwei: 80,
  slippageBps: 150,
  minScore: 65,
  exitPolicy: DEFAULT_EXIT_POLICY,
  walletAddress: null,
};

export interface DeFiPosition {
  id: string;
  symbol: string;
  network: ChainId;
  poolAddress: string;
  dex: string;
  baseSymbol: string;
  baseTokenAddress: string;
  entryPriceUsd: number;
  entryLiquidityUsd: number;
  amountInUsd: number;
  quantity: string; // bigint, as a string (JSON has no bigint)
  status: "OPEN" | "CLOSED";
  openedAt: number;
  closedAt?: number;
  exitPriceUsd?: number;
  realizedPnlUsd?: number;
  closeReason?: string;
  txHashOpen: string;
  txHashClose?: string;
}

export interface DeFiActivityEvent {
  timestamp: number;
  level: "info" | "warn" | "danger";
  detail: string;
}

const MAX_ACTIVITY_EVENTS = 60;

interface WalletFactory {
  (chainId: ChainId, privateKey: `0x${string}`, fetchFn?: typeof fetch): EvmWalletLike;
}

export class DeFiRuntime {
  private readonly storage: RuntimeStorage;
  private readonly fetchFn?: typeof fetch;
  private readonly encryptionKey?: string;
  private readonly walletFactory: WalletFactory;
  private readonly gecko: GeckoTerminalClient;
  private readonly scout: Scout;
  private readonly manualRuntime: TradingRuntime;
  private readonly autoRuntime: TradingRuntime;

  constructor(
    storage: RuntimeStorage,
    opts: { fetchFn?: typeof fetch; encryptionKey?: string; walletFactory?: WalletFactory } = {},
  ) {
    this.storage = storage;
    this.fetchFn = opts.fetchFn;
    this.encryptionKey = opts.encryptionKey;
    this.walletFactory =
      opts.walletFactory ??
      ((chainId, privateKey, fetchFn) => new EvmWallet(chainId, privateKey, { fetchFn }));
    this.gecko = new GeckoTerminalClient({ fetchFn: opts.fetchFn });
    this.scout = new Scout({ fetchFn: opts.fetchFn });
    this.manualRuntime = new TradingRuntime(storage, {
      fetchFn: opts.fetchFn,
      namespace: "defi-manual",
      marketData: new GeckoTerminalMarketDataProvider({ fetchFn: opts.fetchFn }),
    });
    this.autoRuntime = new TradingRuntime(storage, {
      fetchFn: opts.fetchFn,
      namespace: "defi-auto",
      marketData: new GeckoTerminalMarketDataProvider({ fetchFn: opts.fetchFn }),
    });
  }

  // ---- discovery -----------------------------------------------------

  async discover(now = Date.now()): Promise<{ candidates: ScoutCandidate[]; chainErrors: { chain: ChainId; reason: string }[] }> {
    const result = await this.scout.discover({ now, limit: 20 });
    await this.storage.put({ defiCandidates: { ...result, updatedAt: now } });
    return result;
  }

  async getCandidates(): Promise<{ candidates: ScoutCandidate[]; updatedAt: number | null; chainErrors: { chain: ChainId; reason: string }[] }> {
    return (
      (await this.storage.get<{ candidates: ScoutCandidate[]; updatedAt: number; chainErrors: { chain: ChainId; reason: string }[] }>(
        "defiCandidates",
      )) ?? { candidates: [], updatedAt: null, chainErrors: [] }
    );
  }

  // ---- manual: save / analyse -----------------------------------------

  async getSaved(): Promise<string[]> {
    return (await this.storage.get<string[]>("defiSaved")) ?? [];
  }

  /** A trader saves a pool the scout already found — never one typed in
   * freehand, so `symbol` must match a candidate this runtime has actually
   * discovered. */
  async save(symbol: string): Promise<{ saved: string[]; error?: string }> {
    const saved = await this.getSaved();
    if (saved.includes(symbol)) return { saved };
    if (saved.length >= MAX_SAVED_POOLS) {
      return { saved, error: `You can save at most ${MAX_SAVED_POOLS} pools. Remove one first.` };
    }
    const { candidates } = await this.getCandidates();
    if (!candidates.some((c) => c.symbol === symbol)) {
      return { saved, error: "That pool was not among the scouted candidates. Run discovery again and save from there." };
    }
    const next = [...saved, symbol];
    await this.storage.put({ defiSaved: next });
    return { saved: next };
  }

  async unsave(symbol: string): Promise<{ saved: string[] }> {
    const next = (await this.getSaved()).filter((s) => s !== symbol);
    await this.storage.put({ defiSaved: next });
    return { saved: next };
  }

  async getManualSignals(): Promise<{ signals: DeFiSignal[]; updatedAt: number | null }> {
    return (await this.storage.get<{ signals: DeFiSignal[]; updatedAt: number }>("defiManualSignals")) ?? {
      signals: [],
      updatedAt: null,
    };
  }

  /** Run the real analysis engine on every saved pool. Read-only: the same
   * `autoTrading: false` safety property as the CEX spot page. */
  async tickSaved(now = Date.now()): Promise<DeFiSignal[]> {
    const saved = await this.getSaved();
    if (saved.length === 0) return [];
    const previous = (await this.getManualSignals()).signals;
    const byPrevious = new Map(previous.map((s) => [s.symbol, s]));
    const { candidates } = await this.getCandidates();
    const byCandidate = new Map(candidates.map((c) => [c.symbol, c]));

    const results: DeFiSignal[] = [];
    for (const symbol of saved) {
      const parsed = parsePoolSymbol(symbol);
      if (!parsed) continue;
      try {
        const tick = await this.manualRuntime.tick(symbol, {
          mode: "PAPER",
          risk: {},
          autoTrading: false,
          safetyBlocked: false,
          now,
        });
        const valid = tick.analysis.setups.filter((s) => s.status === "VALID").sort((a, b) => b.score - a.score);
        const top = valid[0];
        const candidate = byCandidate.get(symbol);
        const pool = await this.gecko.getPool(parsed.network, parsed.poolAddress).catch(() => null);

        results.push({
          symbol,
          network: parsed.network as ChainId,
          poolAddress: parsed.poolAddress,
          dex: pool?.dex ?? candidate?.dex ?? "unknown",
          baseSymbol: pool?.baseToken.symbol ?? candidate?.baseSymbol ?? "?",
          quoteSymbol: pool?.quoteToken.symbol ?? candidate?.quoteSymbol ?? "?",
          price: pool?.priceUsd ?? candidate?.priceUsd ?? null,
          liquidityUsd: pool?.liquidityUsd ?? candidate?.liquidityUsd ?? 0,
          volumeUsd24h: pool?.volumeUsd24h ?? candidate?.volumeUsd24h ?? 0,
          fdvUsd: pool?.fdvUsd ?? candidate?.fdvUsd ?? null,
          bias: tick.analysis.bias,
          status: tick.status,
          warming: tick.warming,
          noTradeReason: tick.analysis.noTradeReason ?? tick.message ?? null,
          setup: top
            ? {
                direction: top.direction,
                entryModel: top.entryModel,
                timeframe: top.timeframe,
                entry: top.entry,
                stopLoss: top.stopLoss,
                takeProfits: top.takeProfits,
                targetMovesPct: top.takeProfits.map((tp) => ((tp - top.entry) / top.entry) * 100 * (top.direction === "SHORT" ? -1 : 1)),
                nearestTargetPct: top.takeProfits[0] !== undefined ? ((top.takeProfits[0] - top.entry) / top.entry) * 100 * (top.direction === "SHORT" ? -1 : 1) : 0,
                rr: top.rr,
                score: top.score,
                reasons: top.reasons,
                createdAt: top.createdAt,
              }
            : null,
          updatedAt: now,
        });
      } catch (error) {
        const prior = byPrevious.get(symbol);
        if (prior) results.push(prior);
        console.warn(JSON.stringify({
          event: "defi_saved_symbol_failed",
          symbol,
          reason: error instanceof Error ? error.message : String(error),
          timestamp: now,
        }));
      }
    }

    await this.storage.put({ defiManualSignals: { signals: results, updatedAt: now } });
    return results;
  }

  // ---- wallet -----------------------------------------------------------

  private requireEncryptionKey(): string {
    if (!this.encryptionKey) {
      throw new Error("DEFI_WALLET_ENCRYPTION_KEY is not configured on this deployment.");
    }
    return this.encryptionKey;
  }

  /** Generates a fresh wallet, returns the private key once, and stores only
   * its encrypted form and its address. The caller must show that key to the
   * trader now — it is not retrievable again after this call returns. */
  async createWallet(): Promise<{ address: string; privateKey: string }> {
    const key = this.requireEncryptionKey();
    const wallet = generateWallet();
    const encrypted = await encryptSecret(wallet.privateKey, key);
    await this.storage.put({ defiWallet: { address: wallet.address, encrypted } });
    const config = await this.getAutoConfig();
    await this.setAutoConfig({ ...config, walletAddress: wallet.address });
    return { address: wallet.address, privateKey: wallet.privateKey };
  }

  /** Imports a private key the trader already holds. Stored encrypted
   * immediately; the plaintext is never written to storage or logged. */
  async importWallet(privateKey: string): Promise<{ address: string; error?: string }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      return { address: "", error: "That does not look like a private key (expected 0x followed by 64 hex characters)." };
    }
    const key = this.requireEncryptionKey();
    const address = addressFromPrivateKey(privateKey as `0x${string}`);
    const encrypted = await encryptSecret(privateKey, key);
    await this.storage.put({ defiWallet: { address, encrypted } });
    const config = await this.getAutoConfig();
    await this.setAutoConfig({ ...config, walletAddress: address });
    return { address };
  }

  async getWalletAddress(): Promise<string | null> {
    const wallet = await this.storage.get<{ address: string }>("defiWallet");
    return wallet?.address ?? null;
  }

  async removeWallet(): Promise<void> {
    await this.storage.put({ defiWallet: undefined });
    const config = await this.getAutoConfig();
    await this.setAutoConfig({ ...config, walletAddress: null, enabled: false });
  }

  private async decryptedPrivateKey(): Promise<`0x${string}` | null> {
    const wallet = await this.storage.get<{ address: string; encrypted: { iv: string; data: string } }>("defiWallet");
    if (!wallet) return null;
    const key = this.requireEncryptionKey();
    return (await decryptSecret(wallet.encrypted, key)) as `0x${string}`;
  }

  // ---- automated config ---------------------------------------------------

  async getAutoConfig(): Promise<DeFiAutoConfig> {
    return { ...DEFAULT_AUTO_CONFIG, ...((await this.storage.get<Partial<DeFiAutoConfig>>("defiAutoConfig")) ?? {}) };
  }

  async setAutoConfig(patch: Partial<DeFiAutoConfig>): Promise<{ config: DeFiAutoConfig; error?: string }> {
    const current = await this.getAutoConfig();
    const next: DeFiAutoConfig = { ...current, ...patch };

    if (next.perTradeCapUsd <= 0) return { config: current, error: "Per-trade cap must be greater than zero." };
    if (next.perTradeCapUsd > next.allocatedCapitalUsd && next.allocatedCapitalUsd > 0) {
      return { config: current, error: "Per-trade cap cannot exceed the allocated capital." };
    }
    if (next.maxGasPriceGwei <= 0 || next.maxGasPriceGwei > 2000) {
      return { config: current, error: "Max gas price must be between 0 and 2000 gwei." };
    }
    if (next.slippageBps < 0 || next.slippageBps > 2000) {
      return { config: current, error: "Slippage tolerance must be between 0 and 2000 basis points (20%)." };
    }
    if (next.enabled && !(await this.getWalletAddress())) {
      return { config: current, error: "A wallet must be created or imported before automated trading can be enabled." };
    }

    await this.storage.put({ defiAutoConfig: next });
    return { config: next };
  }

  async getPositions(): Promise<DeFiPosition[]> {
    return (await this.storage.get<DeFiPosition[]>("defiPositions")) ?? [];
  }

  private async savePositions(positions: DeFiPosition[]): Promise<void> {
    await this.storage.put({ defiPositions: positions });
  }

  async getActivity(): Promise<DeFiActivityEvent[]> {
    return (await this.storage.get<DeFiActivityEvent[]>("defiActivity")) ?? [];
  }

  private async logActivity(event: DeFiActivityEvent): Promise<void> {
    const events = [event, ...(await this.getActivity())].slice(0, MAX_ACTIVITY_EVENTS);
    await this.storage.put({ defiActivity: events });
  }

  // ---- automated trading --------------------------------------------------

  /**
   * Exit management only: one `getPool` call per open position, plus a swap
   * only on the ticks that actually decide to sell. This is deliberately
   * cheap and called on every alarm tick regardless of what else is running
   * — a held position is risk exposure, and deferring a sell decision to
   * save on subrequests is the wrong thing to defer. Discovery and the full
   * analysis engine (`attemptEntries`) are the expensive half, and get their
   * own, separately-throttled cadence.
   */
  async manageOpenPositions(now = Date.now()): Promise<{ skipped?: string; managed: number }> {
    const config = await this.getAutoConfig();
    if (!config.enabled) return { skipped: "Automated trading is disabled.", managed: 0 };

    const privateKey = await this.decryptedPrivateKey().catch((error) => {
      console.error(JSON.stringify({ event: "defi_wallet_decrypt_failed", reason: error instanceof Error ? error.message : String(error), timestamp: now }));
      return null;
    });
    if (!privateKey) return { skipped: "No wallet configured.", managed: 0 };

    let managed = 0;
    const positions = await this.getPositions();
    const open = positions.filter((p) => p.status === "OPEN");
    for (const position of open) {
      managed++;
      try {
        const pool = await this.gecko.getPool(position.network, position.poolAddress);
        if (!pool) continue;
        const decision = decideExit(
          {
            entryPriceUsd: position.entryPriceUsd,
            currentPriceUsd: pool.priceUsd,
            entryLiquidityUsd: position.entryLiquidityUsd,
            currentLiquidityUsd: pool.liquidityUsd,
          },
          config.exitPolicy,
        );
        if (decision.action !== "SELL_TO_STABLE") continue;

        const wallet = this.walletFactory(position.network, privateKey, this.fetchFn);
        const chain = CHAINS[position.network];
        const gasPrice = await wallet.gasPrice();
        const gasCheck = checkGasCap(gasPrice, config.maxGasPriceGwei);
        if (!gasCheck.ok) {
          await this.logActivity({ timestamp: now, level: "warn", detail: `${position.baseSymbol}: exit deferred — ${gasCheck.reason}` });
          continue;
        }
        const result = await wallet.swap(position.baseTokenAddress, chain.stableAddress, BigInt(position.quantity), {
          slippageBps: config.slippageBps,
        });
        const proceedsUsd = Number(result.amountOutMin) / 10 ** chain.stableDecimals; // conservative: the guaranteed minimum, not the (unknown until confirmed) actual fill
        const next = positions.map((p) =>
          p.id === position.id
            ? {
                ...p,
                status: "CLOSED" as const,
                closedAt: now,
                exitPriceUsd: pool.priceUsd,
                realizedPnlUsd: proceedsUsd - p.amountInUsd,
                closeReason: decision.reason,
                txHashClose: result.txHash,
              }
            : p,
        );
        await this.savePositions(next);
        await this.logActivity({
          timestamp: now,
          level: "info",
          detail: `Sold ${position.baseSymbol} to ${chain.stableSymbol}: ${decision.reason} (tx ${result.txHash})`,
        });
      } catch (error) {
        await this.logActivity({
          timestamp: now,
          level: "danger",
          detail: `${position.baseSymbol}: exit attempt failed — ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { managed };
  }

  /**
   * New entries only: discovery plus the full analysis engine on up to
   * `AUTO_CANDIDATES_PER_TICK` fresh candidates. This is the expensive half —
   * the same reasoning as the CEX spot page's warming deferral applies here,
   * so the caller (the alarm loop in index.ts) runs this on its own, less
   * frequent cadence rather than every tick.
   */
  async attemptEntries(now = Date.now()): Promise<{ skipped?: string; opened: number }> {
    const config = await this.getAutoConfig();
    if (!config.enabled) return { skipped: "Automated trading is disabled.", opened: 0 };

    const privateKey = await this.decryptedPrivateKey().catch((error) => {
      console.error(JSON.stringify({ event: "defi_wallet_decrypt_failed", reason: error instanceof Error ? error.message : String(error), timestamp: now }));
      return null;
    });
    if (!privateKey) return { skipped: "No wallet configured.", opened: 0 };

    let opened = 0;

    const stillOpen = (await this.getPositions()).filter((p) => p.status === "OPEN");
    const committed = stillOpen.reduce((sum, p) => sum + p.amountInUsd, 0);
    const available = config.allocatedCapitalUsd - committed;
    if (available < config.perTradeCapUsd) {
      return { opened };
    }

    let { candidates, updatedAt } = await this.getCandidates();
    if (!updatedAt || now - updatedAt > 15 * 60_000) {
      ({ candidates } = await this.discover(now));
    }
    const heldSymbols = new Set(stillOpen.map((p) => p.symbol));
    const recent = await this.storage.get<Record<string, number>>("defiEntryCooldown") ?? {};
    const eligible = candidates.filter(
      (c) =>
        config.chains.includes(c.network) &&
        !heldSymbols.has(c.symbol) &&
        now - (recent[c.symbol] ?? 0) > ENTRY_COOLDOWN_MS &&
        isV2Compatible(c.dex),
    );

    for (const candidate of eligible.slice(0, AUTO_CANDIDATES_PER_TICK)) {
      if (config.allocatedCapitalUsd - (await this.getPositions()).filter((p) => p.status === "OPEN").reduce((s, p) => s + p.amountInUsd, 0) < config.perTradeCapUsd) {
        break;
      }
      try {
        const tick = await this.autoRuntime.tick(candidate.symbol, {
          mode: "PAPER",
          risk: {},
          autoTrading: false,
          safetyBlocked: false,
          now,
        });
        await this.storage.put({ defiEntryCooldown: { ...recent, [candidate.symbol]: now } });

        const best = tick.analysis.setups
          .filter((s) => s.status === "VALID" && s.direction === "LONG" && s.score >= config.minScore)
          .sort((a, b) => b.score - a.score)[0];
        if (!best) continue;

        const capCheck = checkTradeCap(config.perTradeCapUsd, config.allocatedCapitalUsd);
        if (!capCheck.ok) continue;

        const chain = CHAINS[candidate.network];
        const wallet = this.walletFactory(candidate.network, privateKey, this.fetchFn);
        const gasPrice = await wallet.gasPrice();
        const gasCheck = checkGasCap(gasPrice, config.maxGasPriceGwei);
        if (!gasCheck.ok) {
          await this.logActivity({ timestamp: now, level: "warn", detail: `${candidate.baseSymbol}: entry skipped — ${gasCheck.reason}` });
          continue;
        }

        const amountInUnits = BigInt(Math.round(config.perTradeCapUsd * 10 ** chain.stableDecimals));
        const stableBalance = await wallet.tokenBalance(chain.stableAddress as `0x${string}`);
        if (stableBalance < amountInUnits) {
          await this.logActivity({
            timestamp: now,
            level: "warn",
            detail: `${candidate.baseSymbol}: entry skipped — wallet holds less ${chain.stableSymbol} than the trade requires. Fund the wallet to continue.`,
          });
          continue;
        }

        const result = await wallet.swap(chain.stableAddress, candidate.baseTokenAddress, amountInUnits, {
          slippageBps: config.slippageBps,
        });
        // The guaranteed minimum from the swap, not the (unknown until the
        // receipt's logs are parsed) actual fill — see the module comment on
        // `SwapResult` for why this is treated as an approximation.
        const quantity = result.amountOutMin;

        const position: DeFiPosition = {
          id: `defi-${candidate.symbol}-${now}`,
          symbol: candidate.symbol,
          network: candidate.network,
          poolAddress: candidate.poolAddress,
          dex: candidate.dex,
          baseSymbol: candidate.baseSymbol,
          baseTokenAddress: candidate.baseTokenAddress,
          entryPriceUsd: candidate.priceUsd,
          entryLiquidityUsd: candidate.liquidityUsd,
          amountInUsd: config.perTradeCapUsd,
          quantity: quantity.toString(),
          status: "OPEN",
          openedAt: now,
          txHashOpen: result.txHash,
        };
        await this.savePositions([...(await this.getPositions()), position]);
        await this.logActivity({
          timestamp: now,
          level: "info",
          detail: `Bought ${candidate.baseSymbol} on ${chain.name} (${candidate.dex}): score ${best.score}, $${config.perTradeCapUsd} (tx ${result.txHash})`,
        });
        opened++;
      } catch (error) {
        await this.logActivity({
          timestamp: now,
          level: "danger",
          detail: `${candidate.baseSymbol}: entry attempt failed — ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return { opened };
  }

  /**
   * Both halves together — kept for callers (and tests) that want the whole
   * automated pass in one call. The alarm loop calls the two halves
   * separately on their own cadences instead of this; see the comments on
   * `manageOpenPositions` and `attemptEntries` for why.
   */
  async tickAuto(now = Date.now()): Promise<{ skipped?: string; managed: number; opened: number }> {
    const managed = await this.manageOpenPositions(now);
    if (managed.skipped) return { skipped: managed.skipped, managed: 0, opened: 0 };
    const entries = await this.attemptEntries(now);
    return { managed: managed.managed, opened: entries.opened };
  }
}
