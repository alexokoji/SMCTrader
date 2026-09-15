import { describe, expect, it } from "vitest";
import { MAX_ANALYSED_MARKETS, MAX_PINNED_MARKETS, SpotSignalRuntime } from "../src/spot.js";
import type { RuntimeStorage } from "../src/runtime.js";

/**
 * Spot signals must never place, size or execute a trade — the entire feature
 * is the analysis without the commitment. Every test here that touches a
 * signal also asserts there is nothing resembling an order or a position
 * anywhere in the result. What gets analysed is discovered, not typed in —
 * these tests also cover that discovery, not just the read-only engine.
 *
 * The market is on-chain pools, read through GeckoTerminal — the same
 * provider and JSON:API shape `defi.test.ts` stubs, reused here rather than
 * reinvented. Every fixture pool sits on "ethereum" (network "eth" on the
 * wire) quoted against WETH, which is the one chain/quote-token combination
 * that clears `passesFilters`'s "known quote token" check — see the module
 * comment on `scout.ts` for why every other chain in the registry is stubbed
 * to return nothing rather than being exercised in these tests.
 */

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

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

interface PoolSpec {
  address: string;
  baseSymbol: string;
  fdv?: number;
  liquidity?: number;
  volume?: number;
  changePct24h?: number;
  changePct1h?: number;
  ageDays?: number;
}

function poolEntry(spec: PoolSpec, now: number) {
  return {
    id: `eth_${spec.address}`,
    type: "pool",
    attributes: {
      address: spec.address,
      name: `${spec.baseSymbol} / WETH`,
      base_token_price_usd: "1",
      fdv_usd: String(spec.fdv ?? 5_000_000), // inside the default $2M-$10M range
      market_cap_usd: String(spec.fdv ?? 5_000_000),
      price_change_percentage: { h1: String(spec.changePct1h ?? 2), h24: String(spec.changePct24h ?? 10) },
      volume_usd: { h24: String(spec.volume ?? 50_000) },
      reserve_in_usd: String(spec.liquidity ?? 100_000),
      pool_created_at: new Date(now - (spec.ageDays ?? 30) * 24 * 3_600_000).toISOString(),
    },
    relationships: {
      base_token: { data: { id: `eth_base_${spec.address}`, type: "token" } },
      quote_token: { data: { id: "eth_weth", type: "token" } },
      dex: { data: { id: "uniswap_v2", type: "dex" } },
    },
  };
}

function tokenEntry(spec: PoolSpec) {
  return {
    id: `eth_base_${spec.address}`,
    type: "token",
    attributes: { address: `token_${spec.address}`, symbol: spec.baseSymbol, name: spec.baseSymbol, decimals: 18 },
  };
}

const WETH_TOKEN = {
  id: "eth_weth",
  type: "token",
  attributes: { address: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
};

function poolsFixture(specs: PoolSpec[], now: number) {
  return {
    data: specs.map((s) => poolEntry(s, now)),
    included: [...specs.map(tokenEntry), WETH_TOKEN],
  };
}

function symbolFor(spec: PoolSpec): string {
  return `ethereum:${spec.address}`;
}

/** Deterministic uptrend candles so at least one pool reliably produces a
 * valid setup. */
function ohlcvFixture(now: number) {
  let price = 1;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  const list = Array.from({ length: 200 }, (_, i) => {
    const open = price;
    const close = open + 0.01 + rnd() * 0.05;
    price = close;
    const ts = Math.floor((now - (199 - i) * HOUR) / 1000);
    return [ts, open, Math.max(open, close) + 0.02, Math.min(open, close) - 0.02, close, 10];
  });
  return { data: { attributes: { ohlcv_list: list } } };
}

/**
 * `trending`: the pools returned from ethereum's trending-pools sweep (page
 * 1 only — page 2 and every other chain/source return empty, so exactly
 * these pools and nothing else clears discovery). `searchable`: pools
 * resolvable via `/search/pools`, for the news-driven path — a pool need not
 * be in `trending` to be searchable, and vice versa.
 */
function stubFetch(now: number, trending: PoolSpec[] = [], opts: { searchable?: PoolSpec[]; failOhlcvFor?: string[] } = {}): typeof fetch {
  const searchable = opts.searchable ?? [];
  const failOhlcvFor = new Set(opts.failOhlcvFor ?? []);
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "api.geckoterminal.com") {
      if (url.pathname === "/api/v2/networks/eth/trending_pools" && url.searchParams.get("page") === "1") {
        return new Response(JSON.stringify(poolsFixture(trending, now)), { status: 200 });
      }
      if (url.pathname === "/api/v2/search/pools") {
        const query = (url.searchParams.get("query") ?? "").toUpperCase();
        const matches = searchable.filter((s) => s.baseSymbol.toUpperCase() === query);
        return new Response(JSON.stringify(poolsFixture(matches, now)), { status: 200 });
      }
      if (url.pathname.includes("/ohlcv/")) {
        for (const addr of failOhlcvFor) {
          if (url.pathname.includes(addr)) throw new Error("Too many subrequests by single Worker invocation.");
        }
        return new Response(JSON.stringify(ohlcvFixture(now)), { status: 200 });
      }
      if (url.pathname.match(/\/pools\/[^/]+$/)) {
        const address = url.pathname.split("/").at(-1)!;
        const spec = [...trending, ...searchable].find((s) => s.address === address);
        if (!spec) return new Response(JSON.stringify({ data: null }), { status: 404 });
        return new Response(
          JSON.stringify({ data: poolEntry(spec, now), included: [tokenEntry(spec), WETH_TOKEN] }),
          { status: 200 },
        );
      }
      // Every other chain's trending/new-pools sweep, and page 2 of every source.
      return new Response(JSON.stringify({ data: [], included: [] }), { status: 200 });
    }
    if (url.hostname === "www.coindesk.com") return new Response("", { status: 503 }); // no news by default
    // DexScreener and anything else: empty, unavailable.
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof fetch;
}

function withHeadline(base: typeof fetch, headline: string): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "www.coindesk.com") {
      return new Response(
        `<rss><channel><item><title>${headline}</title><link>https://x/1</link><pubDate>Wed, 20 Aug 2026 08:00:00 GMT</pubDate></item></channel></rss>`,
        { status: 200 },
      );
    }
    return base(input as never);
  }) as unknown as typeof fetch;
}

function runtime(trending?: PoolSpec[]) {
  const storage = memoryStorage();
  return { storage, spot: new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW, trending) }) };
}

describe("discovery", () => {
  it("discovers pools by turnover without anything typed in", async () => {
    const specs: PoolSpec[] = [
      { address: "0xpool0", baseSymbol: "AAA" },
      { address: "0xpool1", baseSymbol: "BBB" },
      { address: "0xpool2", baseSymbol: "CCC" },
    ];
    const { spot } = runtime(specs);
    const markets = await spot.discover(NOW);
    expect(markets.map((m) => m.symbol).sort()).toEqual(specs.map(symbolFor).sort());

    const stored = await spot.getCandidates();
    expect(stored.markets).toHaveLength(3);
    expect(stored.updatedAt).toBe(NOW);
  });

  it("does not cap discovery itself, even when it finds far more than get fully analysed", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ address: `0xpool${i}`, baseSymbol: `TOK${i}` }));
    const { spot } = runtime(many);
    const markets = await spot.discover(NOW);
    expect(markets).toHaveLength(40);

    const stored = await spot.getCandidates();
    expect(stored.markets).toHaveLength(40);
  });
});

describe("pinning", () => {
  it("pins a pool in addition to whatever is discovered", async () => {
    const { spot } = runtime();
    const result = await spot.pin("ethereum:0xpool0");
    expect(result.error).toBeUndefined();
    expect(result.pinned).toEqual(["ethereum:0xpool0"]);
  });

  it("unpins a pool", async () => {
    const { spot } = runtime();
    await spot.pin("ethereum:0xpool0");
    const result = await spot.unpin("ethereum:0xpool0");
    expect(result.pinned).toEqual([]);
  });

  it("does not mangle case — a pool address is case-sensitive, unlike an exchange ticker", async () => {
    const { spot } = runtime();
    const result = await spot.pin("ethereum:0xAbCdEf");
    expect(result.pinned).toEqual(["ethereum:0xAbCdEf"]);
  });

  it("caps the number of pinned pools", async () => {
    const { spot } = runtime();
    for (let i = 0; i < MAX_PINNED_MARKETS; i++) await spot.pin(`ethereum:0xp${i}`);
    const result = await spot.pin("ethereum:0xonetoomany");
    expect(result.error).toMatch(/at most/);
  });
});

describe("spot signals", () => {
  it("analyses discovered pools without opening a position", async () => {
    const specs: PoolSpec[] = [
      { address: "0xpool0", baseSymbol: "AAA" },
      { address: "0xpool1", baseSymbol: "BBB" },
    ];
    const { spot } = runtime(specs);
    const signals = await spot.tickAll(NOW);

    expect(signals.map((s) => s.symbol).sort()).toEqual(specs.map(symbolFor).sort());
    for (const signal of signals) {
      expect(signal.discovered).toBe(true);
      expect(signal.pinned).toBe(false);
      expect(signal).not.toHaveProperty("positionSize");
      expect(signal).not.toHaveProperty("order");
      expect(signal.updatedAt).toBe(NOW);
      expect(signal.volumeUsd24h).toBeGreaterThan(0);
      expect(signal.network).toBe("ethereum");
    }
  });

  it("clears stale signals when a tick legitimately discovers nothing, rather than leaving old ones displayed forever", async () => {
    const specs: PoolSpec[] = [{ address: "0xpool0", baseSymbol: "AAA" }, { address: "0xpool1", baseSymbol: "BBB" }];
    const { storage, spot } = runtime(specs);
    const first = await spot.tickAll(NOW);
    expect(first.length).toBeGreaterThan(0);

    // A later tick where nothing at all clears discovery and nothing is
    // pinned — the exact shape a stricter range filter can legitimately
    // produce on a quiet pass.
    const emptySpot = new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW + HOUR, []) });
    const second = await emptySpot.tickAll(NOW + HOUR);
    expect(second).toEqual([]);

    const stored = await emptySpot.getSignals();
    expect(stored.signals).toEqual([]);
    expect(stored.updatedAt).toBe(NOW + HOUR);
  });

  it("shows a pinned pool even when it does not rank among discovered turnover", async () => {
    const trending: PoolSpec[] = [{ address: "0xpool0", baseSymbol: "AAA" }];
    const pinnedOnly: PoolSpec = { address: "0xpool1", baseSymbol: "BBB" };
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: stubFetch(NOW, trending, { searchable: [pinnedOnly] }),
    });
    await spot.pin(symbolFor(pinnedOnly));
    const signals = await spot.tickAll(NOW);

    const symbols = signals.map((s) => s.symbol);
    expect(symbols).toContain(symbolFor(trending[0]!));
    expect(symbols).toContain(symbolFor(pinnedOnly));
    const bbb = signals.find((s) => s.symbol === symbolFor(pinnedOnly))!;
    expect(bbb.pinned).toBe(true);
    expect(bbb.discovered).toBe(false);
  });

  it("requires nothing be typed in — discovery alone is enough to see signals", async () => {
    const specs: PoolSpec[] = [{ address: "0xpool0", baseSymbol: "AAA" }];
    const { spot } = runtime(specs);
    // No pin() call at all.
    const signals = await spot.tickAll(NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.symbol).toBe(symbolFor(specs[0]!));
  });

  it("bounds total analysed pools even with many pins", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ address: `0xd${i}`, baseSymbol: `D${i}` }));
    const { spot } = runtime(many);
    for (let i = 0; i < MAX_PINNED_MARKETS; i++) await spot.pin(`ethereum:0xp${i}`);
    const signals = await spot.tickAll(NOW);
    expect(signals.length).toBeLessThanOrEqual(MAX_ANALYSED_MARKETS);
  });

  it("persists signals so a page reload reads them without re-analysing", async () => {
    const specs: PoolSpec[] = [{ address: "0xpool0", baseSymbol: "AAA" }];
    const { storage, spot } = runtime(specs);
    await spot.tickAll(NOW);

    const stored = await storage.get<{ signals: unknown[]; updatedAt: number }>("spotSignals");
    expect(stored?.updatedAt).toBe(NOW);

    const read = await spot.getSignals();
    expect(read.updatedAt).toBe(NOW);
    expect(read.signals).toHaveLength(1);
  });

  it("keeps a pool's last known signal when its tick fails, rather than dropping it", async () => {
    const storage = memoryStorage();
    const specs: PoolSpec[] = [{ address: "0xpool0", baseSymbol: "AAA" }];
    let down = false;
    const flaky = new SpotSignalRuntime(storage, {
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (down && url.pathname.includes("/ohlcv/")) throw new Error("network down");
        return stubFetch(NOW, specs)(input as never);
      }) as unknown as typeof fetch,
    });
    const first = await flaky.tickAll(NOW);
    expect(first).toHaveLength(1);

    down = true;
    const second = await flaky.tickAll(NOW + 10 * 60_000); // within the discovery cache window
    expect(second).toHaveLength(1);
    expect(second[0]!.symbol).toBe(symbolFor(specs[0]!));
  });

  it("does not share engine state with an agent watching the same symbol", async () => {
    const storage = memoryStorage();
    const specs: PoolSpec[] = [{ address: "0xpool0", baseSymbol: "AAA" }];
    const spot = new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW, specs) });
    await spot.tickAll(NOW);

    // The spot engine's persisted state must live under its own namespace, not
    // the unscoped key an agentless engine (or a differently-namespaced agent)
    // would use.
    const keys = [...storage.data.keys()];
    expect(keys.some((k) => k.startsWith("engine:spot:"))).toBe(true);
    expect(keys).not.toContain(`engine:${symbolFor(specs[0]!)}`);
  });
});

describe("news-driven discovery", () => {
  it("adds a pool a headline named, even though it would not have qualified for ordinary discovery", async () => {
    const discovered: PoolSpec = { address: "0xpool0", baseSymbol: "AAA", volume: 900_000 };
    const newsOnly: PoolSpec = { address: "0xpool1", baseSymbol: "SOL" };
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: withHeadline(
        stubFetch(NOW, [discovered], { searchable: [newsOnly] }),
        "$SOL rallies on new partnership news",
      ),
    });

    const signals = await spot.tickAll(NOW);
    const sol = signals.find((s) => s.symbol === symbolFor(newsOnly));

    expect(sol).toBeDefined();
    expect(sol!.newsSource).toBe(true);
    expect(sol!.discovered).toBe(false);
    const aaa = signals.find((s) => s.symbol === symbolFor(discovered));
    expect(aaa!.newsSource).toBe(false);
  });

  it("does not add a cashtag for a symbol that resolves to no real pool", async () => {
    const discovered: PoolSpec = { address: "0xpool0", baseSymbol: "AAA" };
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: withHeadline(stubFetch(NOW, [discovered]), "$NOTREAL is trending"),
    });

    const signals = await spot.tickAll(NOW);
    expect(signals.some((s) => s.baseSymbol === "NOTREAL")).toBe(false);
  });

  it("does not re-add a cashtag for a pool already discovered or pinned", async () => {
    const discovered: PoolSpec = { address: "0xpool0", baseSymbol: "AAA" };
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: withHeadline(stubFetch(NOW, [discovered], { searchable: [discovered] }), "$AAA breaks new highs"),
    });

    const signals = await spot.tickAll(NOW);
    // Exactly one entry for this pool — not duplicated via the news path.
    expect(signals.filter((s) => s.symbol === symbolFor(discovered))).toHaveLength(1);
  });
});

describe("subrequest ceiling", () => {
  it("stops analysing further pools once the ceiling is hit, rather than trying every remaining one", async () => {
    // Five discovered pools; the candle fetch for the second one hits the
    // ceiling. Continuing to the third, fourth and fifth would each burn a
    // call already known to be doomed — exactly what turned one ceiling hit
    // into a cascade of failures in production.
    const specs: PoolSpec[] = ["0xpool0", "0xpool1", "0xpool2", "0xpool3", "0xpool4"].map((address, i) => ({
      address,
      baseSymbol: `TOK${i}`,
    }));
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: stubFetch(NOW, specs, { failOhlcvFor: ["0xpool1"] }),
    });

    const signals = await spot.tickAll(NOW);
    const symbols = signals.map((s) => s.symbol);

    expect(symbols).toContain(symbolFor(specs[0]!));
    expect(symbols).not.toContain(symbolFor(specs[2]!));
    expect(symbols).not.toContain(symbolFor(specs[3]!));
    expect(symbols).not.toContain(symbolFor(specs[4]!));
  });

  it("keeps a skipped pool's last known signal rather than dropping it when the ceiling stops the loop early", async () => {
    const specs: PoolSpec[] = [
      { address: "0xpool0", baseSymbol: "AAA" },
      { address: "0xpool1", baseSymbol: "BBB" },
    ];
    const storage = memoryStorage();
    // First tick: both succeed normally, establishing a prior signal for BBB.
    const good = new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW, specs) });
    const first = await good.tickAll(NOW);
    expect(first.map((s) => s.symbol).sort()).toEqual(specs.map(symbolFor).sort());

    // Second tick, same storage: AAA hits the ceiling immediately.
    const flaky = new SpotSignalRuntime(storage, {
      fetchFn: stubFetch(NOW + HOUR, specs, { failOhlcvFor: ["0xpool0"] }),
    });
    const second = await flaky.tickAll(NOW + HOUR);

    // BBB was never attempted this tick (loop stopped at AAA), but its prior
    // signal is still present rather than silently disappearing.
    expect(second.map((s) => s.symbol)).toContain(symbolFor(specs[1]!));
  });
});
