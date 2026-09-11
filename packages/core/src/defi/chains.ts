/**
 * On-chain DeFi trading — chain registry.
 *
 * Scope of this first pass, stated plainly rather than left to be discovered
 * by a missing feature: EVM chains only, against Uniswap-V2-style routers
 * (Uniswap V2, PancakeSwap V2, and their clones). Solana and V3/aggregator
 * routing (Uniswap V3, 1inch, 0x) are not implemented — they need a different
 * signing library and a materially different swap encoding, and are left for
 * a follow-up rather than half-built here.
 *
 * Every address below was cross-checked against its chain's block explorer
 * (Etherscan/BscScan/PolygonScan/Arbiscan/BaseScan) before this was written —
 * that pass alone caught two wrong addresses (a BSC "USDT" that was actually
 * USDC, and an Arbitrum router that was a copy of Base's). Given what a wrong
 * address here costs, re-verify each one independently against the explorer
 * before funding a wallet against this list; treat this registry as a
 * starting point, not a guarantee. Nothing here is user-suppliable at
 * runtime — a trader picks a chain from this list, not a router address — so
 * a mistake or a compromise can only ever be one this file itself made.
 */

export type ChainId = "ethereum" | "bsc" | "polygon" | "arbitrum" | "base";

export interface ChainConfig {
  id: ChainId;
  name: string;
  evmChainId: number;
  nativeSymbol: string;
  /** Public RPC endpoints, tried in order. A user-supplied RPC (e.g. from
   * Alchemy or Infura) can be layered in front of these by the caller for
   * reliability; these are the no-signup fallback. */
  rpcUrls: string[];
  /** Uniswap-V2-style router used for quotes and swaps on this chain. */
  routerAddress: `0x${string}`;
  /** Wrapped native token (WETH/WBNB/WMATIC/...), the path's usual first hop. */
  wrappedNativeAddress: `0x${string}`;
  /** The stablecoin swept-to on take-profit and priced against for P/L. */
  stableAddress: `0x${string}`;
  stableSymbol: string;
  stableDecimals: number;
  explorerUrl: string;
  /** How GeckoTerminal and DexScreener name this chain in their APIs. */
  geckoTerminalNetwork: string;
  dexScreenerChainId: string;
}

export const CHAINS: Record<ChainId, ChainConfig> = {
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    evmChainId: 1,
    nativeSymbol: "ETH",
    rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
    routerAddress: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2 Router02
    wrappedNativeAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    stableAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    stableSymbol: "USDC",
    stableDecimals: 6,
    explorerUrl: "https://etherscan.io",
    geckoTerminalNetwork: "eth",
    dexScreenerChainId: "ethereum",
  },
  bsc: {
    id: "bsc",
    name: "BNB Smart Chain",
    evmChainId: 56,
    nativeSymbol: "BNB",
    rpcUrls: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org"],
    routerAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap V2 Router
    wrappedNativeAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    stableAddress: "0x55d398326f99059fF775485246999027B3197955", // Binance-Peg USDT
    stableSymbol: "USDT",
    stableDecimals: 18,
    explorerUrl: "https://bscscan.com",
    geckoTerminalNetwork: "bsc",
    dexScreenerChainId: "bsc",
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    evmChainId: 137,
    nativeSymbol: "POL",
    rpcUrls: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com"],
    routerAddress: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff", // QuickSwap Router
    wrappedNativeAddress: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC/WPOL
    stableAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // native USDC (Circle)
    stableSymbol: "USDC",
    stableDecimals: 6,
    explorerUrl: "https://polygonscan.com",
    geckoTerminalNetwork: "polygon_pos",
    dexScreenerChainId: "polygon",
  },
  arbitrum: {
    id: "arbitrum",
    name: "Arbitrum One",
    evmChainId: 42161,
    nativeSymbol: "ETH",
    rpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    routerAddress: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // SushiSwap V2 Router (Uniswap V2 ABI-compatible)
    wrappedNativeAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
    stableAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
    stableSymbol: "USDC",
    stableDecimals: 6,
    explorerUrl: "https://arbiscan.io",
    geckoTerminalNetwork: "arbitrum",
    dexScreenerChainId: "arbitrum",
  },
  base: {
    id: "base",
    name: "Base",
    evmChainId: 8453,
    nativeSymbol: "ETH",
    rpcUrls: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    routerAddress: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // Uniswap V2 Router02
    wrappedNativeAddress: "0x4200000000000000000000000000000000000006", // WETH
    stableAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    stableSymbol: "USDC",
    stableDecimals: 6,
    explorerUrl: "https://basescan.org",
    geckoTerminalNetwork: "base",
    dexScreenerChainId: "base",
  },
};

export function chainOf(id: string): ChainConfig | undefined {
  return CHAINS[id as ChainId];
}

export const SUPPORTED_CHAINS: ChainId[] = Object.keys(CHAINS) as ChainId[];
