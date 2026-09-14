import { describe, expect, it } from "vitest";
import type { Timeframe } from "@smc/core";
import { MAX_ANALYSED_MARKETS, MAX_PINNED_MARKETS, SpotSignalRuntime } from "../src/spot.js";
import type { RuntimeStorage } from "../src/runtime.js";

/**
 * Spot signals must never place, size or execute a trade — the entire feature
 * is the analysis without the commitment. Every test here that touches a
 * signal also asserts there is nothing resembling an order or a position
 * anywhere in the result. What gets analysed is discovered, not typed in —
 * these tests also cover that discovery, not just the read-only engine.
 */

const HOUR = 3_600_000;
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

function binanceRow(symbol: string, overrides: Partial<{ price: number; volume: number; changePct: number }> = {}) {
  return {
    symbol,
    lastPrice: String(overrides.price ?? 60_000),
    quoteVolume: String(overrides.volume ?? 500_000_000),
    priceChangePercent: String(overrides.changePct ?? 10), // clears the default movement floor
  };
}

/** CoinGecko's market-cap join is required for a symbol to survive
 * `topMarkets`'s legitimacy floor — every symbol these stubs discover needs
 * a matching row here, or it is (correctly) filtered out as having no
 * verifiable market cap. */
function geckoRow(symbol: string, marketCapUsd = 500_000_000) {
  return {
    symbol: symbol.replace(/USDT$/, "").toLowerCase(),
    market_cap: marketCapUsd,
    total_volume: 500_000_000,
    price_change_percentage_24h: 10,
    current_price: 60_000,
    market_cap_rank: 10,
  };
}

function coingeckoResponse(input: string | URL, symbols: string[]): Response | null {
  const url = new URL(String(input));
  if (url.hostname !== "api.coingecko.com") return null;
  const page = url.searchParams.get("page");
  return new Response(JSON.stringify(page === "1" ? symbols.map((s) => geckoRow(s)) : []), { status: 200 });
}

/** A steady uptrend so at least one market reliably produces a valid setup,
 * plus a bulk 24hr-stats response so discovery has something to rank. */
function stubFetch(now: number, discoveredSymbols: string[] = ["BTCUSDT", "ETHUSDT"]): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/ticker/24hr") {
      return new Response(JSON.stringify(discoveredSymbols.map((s) => binanceRow(s))), { status: 200 });
    }
    const gecko = coingeckoResponse(input, discoveredSymbols);
    if (gecko) return gecko;
    if (!url.pathname.includes("klines") && !url.hostname.includes("binance")) {
      // News feeds and anything else: empty, unavailable response.
      return new Response("", { status: 503 });
    }
    const interval = url.searchParams.get("interval");
    const tf: Timeframe = interval === "4h" ? "4H" : interval === "1h" ? "1H" : "15M";
    const step = tf === "4H" ? 4 * HOUR : tf === "1H" ? HOUR : HOUR / 4;

    let price = 60_000;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    const rows = Array.from({ length: 200 }, (_, i) => {
      const open = price;
      const close = open + 40 + rnd() * 500; // net upward drift
      price = close;
      return [
        now - (199 - i) * step,
        String(open),
        String(Math.max(open, close) + 220),
        String(Math.min(open, close) - 220),
        String(close),
        "10",
      ];
    });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
}

function runtime(discoveredSymbols?: string[]) {
  const storage = memoryStorage();
  return { storage, spot: new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW, discoveredSymbols) }) };
}

/** Extends `stubFetch` with an RSS response carrying a cashtag, and a bulk
 * stats response that includes every symbol in `allSymbols`. Only symbols in
 * `withMarketCap` get a CoinGecko row — a symbol left out of it cannot pass
 * ordinary discovery (no verifiable market cap) but can still be found via
 * the news path, which does not require one. Defaults to every symbol
 * having a cap, for tests that are not exercising that distinction. */
function stubFetchWithNews(
  now: number,
  allSymbols: { symbol: string; volume?: number }[],
  headline: string,
  withMarketCap: string[] = allSymbols.map((s) => s.symbol),
): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/ticker/24hr") {
      return new Response(
        JSON.stringify(allSymbols.map((s) => binanceRow(s.symbol, { volume: s.volume }))),
        { status: 200 },
      );
    }
    const gecko = coingeckoResponse(input, withMarketCap);
    if (gecko) return gecko;
    if (url.hostname === "www.coindesk.com") {
      return new Response(
        `<rss><channel><item><title>${headline}</title><link>https://x/1</link><pubDate>Wed, 20 Aug 2026 08:00:00 GMT</pubDate></item></channel></rss>`,
        { status: 200 },
      );
    }
    if (!url.pathname.includes("klines") && !url.hostname.includes("binance")) {
      return new Response("", { status: 503 }); // other news feeds: unavailable
    }
    return stubFetch(now, allSymbols.map((s) => s.symbol))(input as never);
  }) as unknown as typeof fetch;
}

describe("discovery", () => {
  it("discovers markets by 24h volume without anything typed in", async () => {
    const { spot } = runtime(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    const markets = await spot.discover(NOW);
    expect(markets.map((m) => m.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

    const stored = await spot.getCandidates();
    expect(stored.markets).toHaveLength(3);
    expect(stored.updatedAt).toBe(NOW);
  });

  it("does not cap discovery itself, even when it finds far more than get fully analysed", async () => {
    // The whole point: showing only ~5 majors was the reported problem, and
    // it traced back to discovery itself being capped. This asserts the
    // fix at the layer where it actually lives — discovery — separately
    // from the (still bounded, for cost reasons) full-analysis cap.
    const many = Array.from({ length: 40 }, (_, i) => `TOK${i}USDT`);
    const { spot } = runtime(many);
    const markets = await spot.discover(NOW);
    expect(markets).toHaveLength(40);

    const stored = await spot.getCandidates();
    expect(stored.markets).toHaveLength(40);
  });
});

describe("pinning", () => {
  it("pins a market in addition to whatever is discovered", async () => {
    const { spot } = runtime();
    const result = await spot.pin("dogeusdt");
    expect(result.error).toBeUndefined();
    expect(result.pinned).toEqual(["DOGEUSDT"]);
  });

  it("unpins a market", async () => {
    const { spot } = runtime();
    await spot.pin("DOGEUSDT");
    const result = await spot.unpin("DOGEUSDT");
    expect(result.pinned).toEqual([]);
  });

  it("caps the number of pinned markets", async () => {
    const { spot } = runtime();
    for (let i = 0; i < MAX_PINNED_MARKETS; i++) await spot.pin(`TOK${i}USDT`);
    const result = await spot.pin("ONE_TOO_MANY");
    expect(result.error).toMatch(/at most/);
  });
});

describe("spot signals", () => {
  it("analyses discovered markets without opening a position", async () => {
    const { spot } = runtime(["BTCUSDT", "ETHUSDT"]);
    const signals = await spot.tickAll(NOW);

    expect(signals.map((s) => s.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    for (const signal of signals) {
      expect(signal.discovered).toBe(true);
      expect(signal.pinned).toBe(false);
      expect(signal).not.toHaveProperty("positionSize");
      expect(signal).not.toHaveProperty("order");
      expect(signal.updatedAt).toBe(NOW);
      expect(signal.volumeUsd24h).toBeGreaterThan(0);
    }
  });

  it("shows a pinned market even when it does not rank among discovered volume", async () => {
    const { spot } = runtime(["BTCUSDT"]); // only BTCUSDT discovered
    await spot.pin("ETHUSDT");
    const signals = await spot.tickAll(NOW);

    const symbols = signals.map((s) => s.symbol);
    expect(symbols).toContain("BTCUSDT");
    expect(symbols).toContain("ETHUSDT");
    const eth = signals.find((s) => s.symbol === "ETHUSDT")!;
    expect(eth.pinned).toBe(true);
    expect(eth.discovered).toBe(false);
  });

  it("requires nothing be typed in — discovery alone is enough to see signals", async () => {
    const { spot } = runtime(["BTCUSDT"]);
    // No pin() call at all.
    const signals = await spot.tickAll(NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.symbol).toBe("BTCUSDT");
  });

  it("bounds total analysed markets even with many pins", async () => {
    const { spot } = runtime(Array.from({ length: 10 }, (_, i) => `D${i}USDT`));
    for (let i = 0; i < MAX_PINNED_MARKETS; i++) await spot.pin(`P${i}USDT`);
    const signals = await spot.tickAll(NOW);
    expect(signals.length).toBeLessThanOrEqual(MAX_ANALYSED_MARKETS);
  });

  it("persists signals so a page reload reads them without re-analysing", async () => {
    const { storage, spot } = runtime(["BTCUSDT"]);
    await spot.tickAll(NOW);

    const stored = await storage.get<{ signals: unknown[]; updatedAt: number }>("spotSignals");
    expect(stored?.updatedAt).toBe(NOW);

    const read = await spot.getSignals();
    expect(read.updatedAt).toBe(NOW);
    expect(read.signals).toHaveLength(1);
  });

  it("keeps a market's last known signal when its tick fails, rather than dropping it", async () => {
    const storage = memoryStorage();
    let down = false;
    const flaky = new SpotSignalRuntime(storage, {
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (down && url.pathname.includes("klines")) throw new Error("network down");
        return stubFetch(NOW, ["BTCUSDT"])(input as never);
      }) as unknown as typeof fetch,
    });
    const first = await flaky.tickAll(NOW);
    expect(first).toHaveLength(1);

    down = true;
    const second = await flaky.tickAll(NOW + 20 * 60_000); // within the discovery cache window
    expect(second).toHaveLength(1);
    expect(second[0]!.symbol).toBe("BTCUSDT");
  });

  it("does not share engine state with an agent watching the same symbol", async () => {
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW, ["BTCUSDT"]) });
    await spot.tickAll(NOW);

    // The spot engine's persisted state must live under its own namespace, not
    // the unscoped key an agentless engine (or a differently-namespaced agent)
    // would use.
    const keys = [...storage.data.keys()];
    expect(keys.some((k) => k.startsWith("engine:spot:"))).toBe(true);
    expect(keys).not.toContain("engine:BTCUSDT");
  });
});

describe("news-driven discovery", () => {
  it("fetches bulk exchange stats only once per tick, even when discovery is stale and a headline names something new", async () => {
    // Two 3-exchange bulk fetches (discovery, then news verification) in the
    // same tick was exactly what pushed a production tick over Cloudflare's
    // per-invocation subrequest ceiling. This asserts the fix: one bulk
    // fetch per exchange per tick, reused for both purposes.
    let statsCalls = 0;
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v3/ticker/24hr") statsCalls++;
        return stubFetchWithNews(
          NOW,
          [{ symbol: "BTCUSDT", volume: 900_000_000 }, { symbol: "SOLUSDT", volume: 5_000_000 }],
          "$SOL rallies",
        )(input as never);
      }) as unknown as typeof fetch,
    });

    await spot.tickAll(NOW);

    expect(statsCalls).toBe(1);
  });

  it("adds a market a headline named, even though it would not have qualified for ordinary discovery", async () => {
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: stubFetchWithNews(
        NOW,
        [
          { symbol: "BTCUSDT", volume: 900_000_000 }, // discovered normally
          { symbol: "SOLUSDT", volume: 5_000_000 }, // no market cap row below — news-eligible only
        ],
        "$SOL rallies on new partnership news",
        ["BTCUSDT"], // only BTC gets a CoinGecko market-cap row
      ),
    });

    const signals = await spot.tickAll(NOW);
    const sol = signals.find((s) => s.symbol === "SOLUSDT");

    expect(sol).toBeDefined();
    expect(sol!.newsSource).toBe(true);
    expect(sol!.discovered).toBe(false);
    const btc = signals.find((s) => s.symbol === "BTCUSDT");
    expect(btc!.newsSource).toBe(false);
  });

  it("does not add a cashtag mention that fails the reduced news volume floor", async () => {
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: stubFetchWithNews(
        NOW,
        [
          { symbol: "BTCUSDT", volume: 900_000_000 },
          { symbol: "TINYUSDT", volume: 1_000 }, // far below even the news floor
        ],
        "$TINY surges 40%",
      ),
    });

    const signals = await spot.tickAll(NOW);
    expect(signals.find((s) => s.symbol === "TINYUSDT")).toBeUndefined();
  });

  it("does not add a cashtag for a symbol that is not a real tradeable pair", async () => {
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: stubFetchWithNews(NOW, [{ symbol: "BTCUSDT", volume: 900_000_000 }], "$NOTREAL is trending"),
    });

    const signals = await spot.tickAll(NOW);
    expect(signals.map((s) => s.symbol)).not.toContain("NOTREALUSDT");
  });

  it("does not re-add a cashtag for a market already discovered or pinned", async () => {
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: stubFetchWithNews(NOW, [{ symbol: "BTCUSDT", volume: 900_000_000 }], "$BTC breaks new highs"),
    });

    const signals = await spot.tickAll(NOW);
    // Exactly one BTCUSDT entry — not duplicated via the news path.
    expect(signals.filter((s) => s.symbol === "BTCUSDT")).toHaveLength(1);
  });
});

describe("subrequest ceiling", () => {
  it("stops analysing further markets once the ceiling is hit, rather than trying every remaining one", async () => {
    // Five discovered markets; the candle fetch for the second one hits the
    // ceiling. Continuing to the third, fourth and fifth would each burn a
    // call already known to be doomed — exactly what turned one ceiling hit
    // into a cascade of failures in production.
    const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"];
    let klineAttempts = 0;
    const base = stubFetch(NOW, symbols);
    const storage = memoryStorage();
    const spot = new SpotSignalRuntime(storage, {
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.includes("klines")) {
          klineAttempts++;
          if (url.searchParams.get("symbol") === "BBBUSDT") {
            throw new Error("Too many subrequests by single Worker invocation.");
          }
        }
        return base(input as never);
      }) as unknown as typeof fetch,
    });

    const signals = await spot.tickAll(NOW);

    // AAA analysed, BBB failed on the ceiling, and the loop stopped —
    // CCC/DDD/EEE were never attempted at all this tick, so total klines
    // calls stay far below the ~15 a full 5-symbol/3-timeframe pass would
    // otherwise cost.
    expect(signals.map((s) => s.symbol)).toContain("AAAUSDT");
    expect(signals.map((s) => s.symbol)).not.toContain("CCCUSDT");
    expect(signals.map((s) => s.symbol)).not.toContain("DDDUSDT");
    expect(signals.map((s) => s.symbol)).not.toContain("EEEUSDT");
    expect(klineAttempts).toBeLessThan(10);
  });

  it("keeps a skipped market's last known signal rather than dropping it when the ceiling stops the loop early", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT"];
    const storage = memoryStorage();
    // First tick: both succeed normally, establishing a prior signal for BBB.
    const good = new SpotSignalRuntime(storage, { fetchFn: stubFetch(NOW, symbols) });
    const first = await good.tickAll(NOW);
    expect(first.map((s) => s.symbol).sort()).toEqual(["AAAUSDT", "BBBUSDT"]);

    // Second tick, same storage: AAA hits the ceiling immediately.
    const base = stubFetch(NOW + HOUR, symbols);
    const flaky = new SpotSignalRuntime(storage, {
      fetchFn: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.includes("klines") && url.searchParams.get("symbol") === "AAAUSDT") {
          throw new Error("Too many subrequests by single Worker invocation.");
        }
        return base(input as never);
      }) as unknown as typeof fetch,
    });
    const second = await flaky.tickAll(NOW + HOUR);

    // BBB was never attempted this tick (loop stopped at AAA), but its prior
    // signal is still present rather than silently disappearing.
    expect(second.map((s) => s.symbol)).toContain("BBBUSDT");
  });
});
