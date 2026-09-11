/**
 * EVM swap execution against a Uniswap-V2-style router.
 *
 * Split deliberately in two: the functions in the first half compute what a
 * swap should look like (path, minimum output, whether native ETH/BNB/... is
 * involved) with no network access, so they are exercised by ordinary unit
 * tests; `EvmWallet` at the bottom is the thin, mostly-glue class that holds
 * real viem clients and actually calls a chain. There is no test rig here
 * standing in for a live RPC and a funded wallet — that half needs to be
 * exercised against a real testnet before this signs anything on mainnet.
 */
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  isAddress,
  parseUnits,
  formatUnits,
  type Address,
  type Hash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import * as viemChains from "viem/chains";
import { CHAINS, type ChainConfig, type ChainId } from "./chains.js";

export const ROUTER_V2_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "swapExactTokensForTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "swapExactETHForTokens",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "swapExactTokensForETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

/** viem's canonical Chain object for each registry entry — RPC/gas plumbing
 * is exactly the kind of thing better sourced from a maintained library than
 * hand-rolled here; the trading-specific addresses stay in `chains.ts`. */
const VIEM_CHAIN: Record<ChainId, viemChains.Chain> = {
  ethereum: viemChains.mainnet,
  bsc: viemChains.bsc,
  polygon: viemChains.polygon,
  arbitrum: viemChains.arbitrum,
  base: viemChains.base,
};

// ---------------------------------------------------------------------------
// Pure logic — no network, fully unit-testable.
// ---------------------------------------------------------------------------

export function generateWallet(): { privateKey: `0x${string}`; address: Address } {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export function addressFromPrivateKey(privateKey: `0x${string}`): Address {
  return privateKeyToAccount(privateKey).address;
}

const NATIVE_SENTINEL = "native";

/** True when the "token" is really the chain's native coin, not an ERC-20. */
export function isNative(tokenAddress: string): boolean {
  return tokenAddress.toLowerCase() === NATIVE_SENTINEL;
}

/**
 * The router path for a swap. Any pair not already routing through the
 * wrapped native token is routed through it (tokenIn -> WETH -> tokenOut) —
 * the standard V2 fallback, since a V2 router has no built-in multi-hop
 * discovery of its own and most real liquidity sits against the native pair.
 */
export function buildSwapPath(chain: ChainConfig, tokenIn: string, tokenOut: string): Address[] {
  const wrapped = chain.wrappedNativeAddress;
  const inAddr = isNative(tokenIn) ? wrapped : (tokenIn as Address);
  const outAddr = isNative(tokenOut) ? wrapped : (tokenOut as Address);
  if (inAddr.toLowerCase() === wrapped.toLowerCase() || outAddr.toLowerCase() === wrapped.toLowerCase()) {
    return [inAddr, outAddr];
  }
  return [inAddr, wrapped, outAddr];
}

/** Minimum acceptable output for a quoted amount, given a slippage tolerance in basis points. */
export function minAmountOut(quotedOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 5_000) {
    throw new Error(`slippageBps ${slippageBps} is outside a sane 0-5000 bps range.`);
  }
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export interface TradeCapCheck {
  ok: boolean;
  reason?: string;
}

/** A hard ceiling on notional per trade — the single control that bounds
 * what one bad decision (or one compromised key) can move in one transaction. */
export function checkTradeCap(amountUsd: number, maxUsd: number): TradeCapCheck {
  if (amountUsd > maxUsd) {
    return { ok: false, reason: `Trade of $${amountUsd.toFixed(2)} exceeds the configured cap of $${maxUsd.toFixed(2)}.` };
  }
  return { ok: true };
}

/** A ceiling on gas price — protects against paying an absurd fee during a
 * spike, and against a malformed or manipulated fee estimate. */
export function checkGasCap(gasPriceWei: bigint, maxGasPriceGwei: number): TradeCapCheck {
  const maxWei = parseUnits(String(maxGasPriceGwei), 9);
  if (gasPriceWei > maxWei) {
    return {
      ok: false,
      reason: `Gas price ${formatUnits(gasPriceWei, 9)} gwei exceeds the configured cap of ${maxGasPriceGwei} gwei.`,
    };
  }
  return { ok: true };
}

export function isValidAddress(value: string): value is Address {
  return isAddress(value);
}

// ---------------------------------------------------------------------------
// Network-dependent execution.
// ---------------------------------------------------------------------------

export interface SwapQuote {
  amountIn: bigint;
  amountOut: bigint;
  path: Address[];
}

export interface SwapResult {
  txHash: Hash;
  amountIn: bigint;
  amountOutMin: bigint;
  path: Address[];
}

/** The subset of `EvmWallet` a caller needs — small enough that a test can
 * substitute a stub for it without a real chain or RPC. */
export interface EvmWalletLike {
  readonly address: Address;
  nativeBalance(): Promise<bigint>;
  tokenBalance(tokenAddress: Address): Promise<bigint>;
  tokenDecimals(tokenAddress: Address): Promise<number>;
  quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<SwapQuote>;
  swap(tokenIn: string, tokenOut: string, amountIn: bigint, opts: { slippageBps: number; deadlineSeconds?: number }): Promise<SwapResult>;
  gasPrice(): Promise<bigint>;
}

export class EvmWallet implements EvmWalletLike {
  private readonly chain: ChainConfig;
  private readonly account: PrivateKeyAccount;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;

  constructor(chainId: ChainId, privateKey: `0x${string}`, opts: { rpcUrl?: string; fetchFn?: typeof fetch } = {}) {
    this.chain = CHAINS[chainId];
    this.account = privateKeyToAccount(privateKey);
    const rpcUrl = opts.rpcUrl ?? this.chain.rpcUrls[0]!;
    const transport = http(rpcUrl, opts.fetchFn ? { fetchFn: opts.fetchFn } : {});
    const viemChain = VIEM_CHAIN[chainId];
    this.publicClient = createPublicClient({ chain: viemChain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain: viemChain, transport });
  }

  get address(): Address {
    return this.account.address;
  }

  async nativeBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  async tokenBalance(tokenAddress: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    });
  }

  async tokenDecimals(tokenAddress: Address): Promise<number> {
    return this.publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "decimals" });
  }

  /** Read-only: what the router quotes for a swap, no gas spent. */
  async quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<SwapQuote> {
    const path = buildSwapPath(this.chain, tokenIn, tokenOut);
    const amounts = await this.publicClient.readContract({
      address: this.chain.routerAddress,
      abi: ROUTER_V2_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, path],
    });
    return { amountIn, amountOut: amounts[amounts.length - 1]!, path };
  }

  private async ensureAllowance(tokenAddress: Address, amount: bigint): Promise<void> {
    const allowance = await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.chain.routerAddress],
    });
    if (allowance >= amount) return;
    const hash = await this.walletClient.writeContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.chain.routerAddress, amount],
      chain: this.walletClient.chain,
      account: this.account,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /**
   * Execute a swap. `slippageBps` is applied to a fresh quote taken
   * immediately before sending, not to one the caller may be holding stale —
   * a quote a few blocks old is exactly how a swap ends up trading through
   * more slippage than intended.
   */
  async swap(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    opts: { slippageBps: number; deadlineSeconds?: number },
  ): Promise<SwapResult> {
    const quote = await this.quote(tokenIn, tokenOut, amountIn);
    const amountOutMin = minAmountOut(quote.amountOut, opts.slippageBps);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 300));

    if (!isNative(tokenIn)) {
      await this.ensureAllowance(tokenIn as Address, amountIn);
    }

    let hash: Hash;
    if (isNative(tokenIn)) {
      hash = await this.walletClient.writeContract({
        address: this.chain.routerAddress,
        abi: ROUTER_V2_ABI,
        functionName: "swapExactETHForTokens",
        args: [amountOutMin, quote.path, this.account.address, deadline],
        value: amountIn,
        chain: this.walletClient.chain,
        account: this.account,
      });
    } else if (isNative(tokenOut)) {
      hash = await this.walletClient.writeContract({
        address: this.chain.routerAddress,
        abi: ROUTER_V2_ABI,
        functionName: "swapExactTokensForETH",
        args: [amountIn, amountOutMin, quote.path, this.account.address, deadline],
        chain: this.walletClient.chain,
        account: this.account,
      });
    } else {
      hash = await this.walletClient.writeContract({
        address: this.chain.routerAddress,
        abi: ROUTER_V2_ABI,
        functionName: "swapExactTokensForTokens",
        args: [amountIn, amountOutMin, quote.path, this.account.address, deadline],
        chain: this.walletClient.chain,
        account: this.account,
      });
    }

    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash, amountIn, amountOutMin, path: quote.path };
  }

  async gasPrice(): Promise<bigint> {
    return this.publicClient.getGasPrice();
  }
}
