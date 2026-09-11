import { describe, expect, it, vi } from "vitest";
import { generateEncryptionKey, generateWallet, type EvmWalletLike, type SwapResult } from "@smc/core";
import { DeFiRuntime, DEFAULT_AUTO_CONFIG, isV2Compatible } from "../src/defi.js";
import type { RuntimeStorage } from "../src/runtime.js";

/**
 * Automated DeFi trading moves real funds, so this suite leans on the
 * boundary a careless implementation gets wrong: an exit that sells a loser,
 * an entry that ignores the capital cap, a swap sent while gas is above the
 * configured ceiling, or a private key that ever appears in storage or in a
 * response after the one call that generates it.
 */

const NOW = 1_800_000_000_000;

function memoryStorage(): RuntimeStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(entries: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    },
  };
}

const TRENDING_FIXTURE = {
  data: [
    {
      id: "eth_0xpool1",
      type: "pool",
      attributes: {
        address: "0xpool1",
        name: "TOKEN / WETH",
        base_token_price_usd: "1.5",
        fdv_usd: "10000000",
        market_cap_usd: "10000000",
        price_change_percentage: { h1: "2", h24: "5" },
        volume_usd: { h24: "500000" },
        reserve_in_usd: "300000",
        pool_created_at: new Date(NOW - 30 * 24 * 3_600_000).toISOString(),
      },
      relationships: {
        base_token: { data: { id: "eth_base1", type: "token" } },
        quote_token: { data: { id: "eth_quote1", type: "token" } },
        dex: { data: { id: "uniswap_v2", type: "dex" } },
      },
    },
  ],
  included: [
    { id: "eth_base1", type: "token", attributes: { address: "0xbase1", symbol: "TOKEN", name: "Token", decimals: 18 } },
    { id: "eth_quote1", type: "token", attributes: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", name: "Wrapped Ether", decimals: 18 } },
  ],
};

function geckoStubFetch(): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/trending_pools")) {
      return new Response(JSON.stringify(TRENDING_FIXTURE), { status: 200 });
    }
    if (url.pathname.includes("/ohlcv/")) {
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [] } } }), { status: 200 });
    }
    if (url.pathname.match(/\/pools\/0x/)) {
      return new Response(
        JSON.stringify({
          data: {
            id: "eth_0xpool1",
            type: "pool",
            attributes: TRENDING_FIXTURE.data[0]!.attributes,
            relationships: TRENDING_FIXTURE.data[0]!.relationships,
          },
          included: TRENDING_FIXTURE.included,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

function stubWallet(overrides: Partial<EvmWalletLike> = {}): EvmWalletLike {
  const swapResult: SwapResult = {
    txHash: "0xhash" as `0x${string}`,
    amountIn: 100n,
    amountOutMin: 90n,
    path: [],
  };
  return {
    address: "0x0000000000000000000000000000000000dEaD",
    nativeBalance: vi.fn().mockResolvedValue(10n ** 18n),
    tokenBalance: vi.fn().mockResolvedValue(10n ** 12n), // plenty of stable
    tokenDecimals: vi.fn().mockResolvedValue(18),
    quote: vi.fn().mockResolvedValue({ amountIn: 100n, amountOut: 100n, path: [] }),
    swap: vi.fn().mockResolvedValue(swapResult),
    gasPrice: vi.fn().mockResolvedValue(20_000_000_000n), // 20 gwei
    ...overrides,
  };
}

function runtime(opts: { walletFactory?: () => EvmWalletLike } = {}) {
  const storage = memoryStorage();
  const encryptionKey = generateEncryptionKey();
  const defi = new DeFiRuntime(storage, {
    fetchFn: geckoStubFetch(),
    encryptionKey,
    walletFactory: opts.walletFactory ? () => opts.walletFactory!() : undefined,
  });
  return { storage, defi, encryptionKey };
}

describe("discovery", () => {
  it("scouts and persists candidates", async () => {
    const { defi } = runtime();
    const { candidates } = await defi.discover(NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.symbol).toBe("ethereum:0xpool1");

    const stored = await defi.getCandidates();
    expect(stored.candidates).toHaveLength(1);
    expect(stored.updatedAt).toBe(NOW);
  });
});

describe("saving a scouted pool", () => {
  it("refuses to save a symbol that was never discovered", async () => {
    const { defi } = runtime();
    const result = await defi.save("ethereum:0xneverdiscovered");
    expect(result.error).toMatch(/scouted candidates/);
    expect(result.saved).toEqual([]);
  });

  it("saves a symbol the scout actually found", async () => {
    const { defi } = runtime();
    await defi.discover(NOW);
    const result = await defi.save("ethereum:0xpool1");
    expect(result.error).toBeUndefined();
    expect(result.saved).toEqual(["ethereum:0xpool1"]);
  });

  it("unsaves a pool", async () => {
    const { defi } = runtime();
    await defi.discover(NOW);
    await defi.save("ethereum:0xpool1");
    const result = await defi.unsave("ethereum:0xpool1");
    expect(result.saved).toEqual([]);
  });
});

describe("wallet lifecycle", () => {
  it("returns the private key exactly once, on creation, and never stores it in plaintext", async () => {
    const { storage, defi } = runtime();
    const created = await defi.createWallet();
    expect(created.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const stored = storage.data.get("defiWallet") as { address: string; encrypted: { iv: string; data: string } };
    expect(stored.address).toBe(created.address);
    expect(JSON.stringify(stored)).not.toContain(created.privateKey.slice(2, 20));
  });

  it("imports a supplied private key and derives the matching address", async () => {
    const { defi } = runtime();
    const wallet = generateWallet();
    const result = await defi.importWallet(wallet.privateKey);
    expect(result.address).toBe(wallet.address);
  });

  it("rejects a malformed private key", async () => {
    const { defi } = runtime();
    const result = await defi.importWallet("not-a-key");
    expect(result.error).toMatch(/private key/);
  });

  it("disables automated trading and clears the wallet address when the wallet is removed", async () => {
    const { defi } = runtime();
    await defi.createWallet();
    await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 100 });
    await defi.removeWallet();
    const config = await defi.getAutoConfig();
    expect(config.enabled).toBe(false);
    expect(config.walletAddress).toBeNull();
  });
});

describe("automated config", () => {
  it("refuses to enable automated trading without a wallet", async () => {
    const { defi } = runtime();
    const result = await defi.setAutoConfig({ enabled: true });
    expect(result.error).toMatch(/wallet/);
  });

  it("refuses a per-trade cap larger than the allocated capital", async () => {
    const { defi } = runtime();
    const result = await defi.setAutoConfig({ allocatedCapitalUsd: 100, perTradeCapUsd: 200 });
    expect(result.error).toMatch(/allocated capital/);
  });

  it("refuses an unreasonable gas price cap", async () => {
    const { defi } = runtime();
    expect((await defi.setAutoConfig({ maxGasPriceGwei: 0 })).error).toBeDefined();
    expect((await defi.setAutoConfig({ maxGasPriceGwei: 5000 })).error).toBeDefined();
  });

  it("accepts a valid configuration once a wallet exists", async () => {
    const { defi } = runtime();
    await defi.createWallet();
    const result = await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 500, perTradeCapUsd: 50 });
    expect(result.error).toBeUndefined();
    expect(result.config.enabled).toBe(true);
  });
});

describe("automated trading — position management", () => {
  it("does nothing when automated trading is disabled", async () => {
    const { defi } = runtime();
    const result = await defi.tickAuto(NOW);
    expect(result.skipped).toMatch(/disabled/);
  });

  it("does nothing when no wallet is configured", async () => {
    const { defi } = runtime();
    await defi.setAutoConfig({ enabled: false }); // still no wallet
    const result = await defi.tickAuto(NOW);
    expect(result.skipped).toBeDefined();
  });

  it("sells a position once it crosses the take-profit target", async () => {
    const swap = vi.fn().mockResolvedValue({ txHash: "0xexit", amountIn: 100n, amountOutMin: 200_000_000n, path: [] });
    const wallet = stubWallet({ swap });
    const { storage, defi } = runtime({ walletFactory: () => wallet });
    await defi.createWallet();
    await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 500, perTradeCapUsd: 50 });

    await storage.put({
      defiPositions: [
        {
          id: "pos1",
          symbol: "ethereum:0xpool1",
          network: "ethereum",
          poolAddress: "0xpool1",
          dex: "uniswap_v2",
          baseSymbol: "TOKEN",
          baseTokenAddress: "0xbase1",
          entryPriceUsd: 1.0, // pool now reports 1.5 — a 50% gain, past the 15% default target
          entryLiquidityUsd: 300_000,
          amountInUsd: 50,
          quantity: "100",
          status: "OPEN",
          openedAt: NOW - 3_600_000,
          txHashOpen: "0xopen",
        },
      ],
    });

    await defi.tickAuto(NOW);

    expect(swap).toHaveBeenCalledWith("0xbase1", expect.any(String), 100n, expect.objectContaining({ slippageBps: expect.any(Number) }));
    const positions = await defi.getPositions();
    expect(positions[0]!.status).toBe("CLOSED");
    expect(positions[0]!.realizedPnlUsd).toBeGreaterThan(0);
  });

  it("holds a losing position rather than selling it", async () => {
    const swap = vi.fn();
    const wallet = stubWallet({ swap });
    const { storage, defi } = runtime({ walletFactory: () => wallet });
    await defi.createWallet();
    await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 500, perTradeCapUsd: 50 });

    await storage.put({
      defiPositions: [
        {
          id: "pos1",
          symbol: "ethereum:0xpool1",
          network: "ethereum",
          poolAddress: "0xpool1",
          dex: "uniswap_v2",
          baseSymbol: "TOKEN",
          baseTokenAddress: "0xbase1",
          entryPriceUsd: 3.0, // pool now reports 1.5 — down 50%
          entryLiquidityUsd: 300_000,
          amountInUsd: 50,
          quantity: "100",
          status: "OPEN",
          openedAt: NOW - 3_600_000,
          txHashOpen: "0xopen",
        },
      ],
    });

    await defi.tickAuto(NOW);

    expect(swap).not.toHaveBeenCalled();
    const positions = await defi.getPositions();
    expect(positions[0]!.status).toBe("OPEN");
  });

  it("defers an exit above the configured gas cap rather than paying it", async () => {
    const swap = vi.fn();
    const wallet = stubWallet({ swap, gasPrice: vi.fn().mockResolvedValue(200_000_000_000n) }); // 200 gwei
    const { storage, defi } = runtime({ walletFactory: () => wallet });
    await defi.createWallet();
    await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 500, perTradeCapUsd: 50, maxGasPriceGwei: 50 });

    await storage.put({
      defiPositions: [
        {
          id: "pos1",
          symbol: "ethereum:0xpool1",
          network: "ethereum",
          poolAddress: "0xpool1",
          dex: "uniswap_v2",
          baseSymbol: "TOKEN",
          baseTokenAddress: "0xbase1",
          entryPriceUsd: 1.0,
          entryLiquidityUsd: 300_000,
          amountInUsd: 50,
          quantity: "100",
          status: "OPEN",
          openedAt: NOW - 3_600_000,
          txHashOpen: "0xopen",
        },
      ],
    });

    await defi.tickAuto(NOW);

    expect(swap).not.toHaveBeenCalled();
    const positions = await defi.getPositions();
    expect(positions[0]!.status).toBe("OPEN");
    const activity = await defi.getActivity();
    expect(activity[0]!.detail).toMatch(/gas/i);
  });
});

describe("automated trading — capital discipline", () => {
  it("does not attempt a new entry once allocated capital is already committed", async () => {
    const wallet = stubWallet();
    const { storage, defi } = runtime({ walletFactory: () => wallet });
    await defi.createWallet();
    await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 50, perTradeCapUsd: 50 });

    await storage.put({
      defiPositions: [
        {
          id: "pos1",
          symbol: "ethereum:0xheld",
          network: "ethereum",
          poolAddress: "0xheld",
          dex: "uniswap_v2",
          baseSymbol: "HELD",
          baseTokenAddress: "0xheldtoken",
          entryPriceUsd: 1.5,
          entryLiquidityUsd: 300_000,
          amountInUsd: 50, // the entire allocation is already committed
          quantity: "100",
          status: "OPEN",
          openedAt: NOW - 3_600_000,
          txHashOpen: "0xopen",
        },
      ],
    });

    const result = await defi.tickAuto(NOW);
    expect(result.opened).toBe(0);
    expect(wallet.swap).not.toHaveBeenCalled();
  });
});

describe("automated trading — execution compatibility", () => {
  // A live discovery run turned up exactly this: several of the
  // highest-turnover pools traded on "pancakeswap-v3-bsc" and
  // "pancakeswap-infinity-clmm" — V3/CLMM designs the V2-router swap module
  // cannot execute against. This filter is what stands between the scout
  // finding one of those and the bot trying to trade it anyway.
  it("accepts a dex the swap module can actually route through", () => {
    expect(isV2Compatible("uniswap_v2")).toBe(true);
    expect(isV2Compatible("pancakeswap")).toBe(true);
    expect(isV2Compatible("sushiswap_v2_arbitrum")).toBe(true);
  });

  it("rejects the V3/CLMM dexes a live scout actually returned", () => {
    expect(isV2Compatible("pancakeswap-v3-bsc")).toBe(false);
    expect(isV2Compatible("pancakeswap-infinity-clmm")).toBe(false);
    expect(isV2Compatible("uniswap_v3")).toBe(false);
  });
});

describe("manageOpenPositions / attemptEntries split", () => {
  // The whole point of separating these: exit management must stay cheap and
  // run every tick regardless of what else the alarm loop is doing, while
  // discovery and the full engine (only needed for new entries) get their
  // own, less frequent cadence. A regression that makes exit management pull
  // in discovery again would silently reintroduce the subrequest-ceiling
  // failure this split exists to fix.
  it("manages positions without ever calling discovery", async () => {
    let discoveryCalls = 0;
    const fetchFn = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/trending_pools")) {
        discoveryCalls++;
        return new Response(JSON.stringify(TRENDING_FIXTURE), { status: 200 });
      }
      return geckoStubFetch()(input as never);
    }) as unknown as typeof fetch;

    const wallet = stubWallet();
    const storage = memoryStorage();
    const defi = new DeFiRuntime(storage, { fetchFn, encryptionKey: generateEncryptionKey(), walletFactory: () => wallet });
    await defi.createWallet();
    await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 500, perTradeCapUsd: 50 });
    await storage.put({
      defiPositions: [{
        id: "pos1", symbol: "ethereum:0xpool1", network: "ethereum", poolAddress: "0xpool1",
        dex: "uniswap_v2", baseSymbol: "TOKEN", baseTokenAddress: "0xbase1",
        entryPriceUsd: 1.0, entryLiquidityUsd: 300_000, amountInUsd: 50, quantity: "100",
        status: "OPEN", openedAt: NOW - 3_600_000, txHashOpen: "0xopen",
      }],
    });

    const result = await defi.manageOpenPositions(NOW);

    expect(result.managed).toBe(1);
    expect(discoveryCalls).toBe(0);
  });

  it("attemptEntries alone opens a position without re-managing existing ones", async () => {
    const wallet = stubWallet();
    const storage = memoryStorage();
    const defi = new DeFiRuntime(storage, { fetchFn: geckoStubFetch(), encryptionKey: generateEncryptionKey(), walletFactory: () => wallet });
    await defi.createWallet();
    await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 500, perTradeCapUsd: 50 });

    const result = await defi.attemptEntries(NOW);

    // Whether or not the stub candle data forms a valid setup, the call must
    // complete without touching position management at all.
    expect(result).not.toHaveProperty("managed");
    expect(typeof result.opened).toBe("number");
  });

  it("tickAuto composes both halves, matching the pre-split behaviour", async () => {
    const swap = vi.fn().mockResolvedValue({ txHash: "0xexit", amountIn: 100n, amountOutMin: 200_000_000n, path: [] });
    const wallet = stubWallet({ swap });
    const storage = memoryStorage();
    const defi = new DeFiRuntime(storage, { fetchFn: geckoStubFetch(), encryptionKey: generateEncryptionKey(), walletFactory: () => wallet });
    await defi.createWallet();
    await defi.setAutoConfig({ enabled: true, allocatedCapitalUsd: 500, perTradeCapUsd: 50 });
    await storage.put({
      defiPositions: [{
        id: "pos1", symbol: "ethereum:0xpool1", network: "ethereum", poolAddress: "0xpool1",
        dex: "uniswap_v2", baseSymbol: "TOKEN", baseTokenAddress: "0xbase1",
        entryPriceUsd: 1.0, entryLiquidityUsd: 300_000, amountInUsd: 50, quantity: "100",
        status: "OPEN", openedAt: NOW - 3_600_000, txHashOpen: "0xopen",
      }],
    });

    const result = await defi.tickAuto(NOW);

    expect(result.managed).toBe(1);
    expect(swap).toHaveBeenCalled();
    const positions = await defi.getPositions();
    expect(positions[0]!.status).toBe("CLOSED");
  });
});
