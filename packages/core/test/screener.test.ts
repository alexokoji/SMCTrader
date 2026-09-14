import { describe, expect, it } from "vitest";
import { CexScreener, DEFAULT_SCREENER_FILTERS, isTradeableBase } from "../src/marketdata/screener.js";

/**
 * Ranking here is deliberately not "highest volume first" — that ordering
 * only ever surfaces BTC/ETH, which are always the most-traded pairs and
 * among the least volatile. Market cap is a legitimacy floor; the coins that
 * clear it are ranked by how much they are moving relative to their own
 * size. Every test below exercises that split: a filter test constructs a
 * pool that fails exactly one gate (cap, volume, movement) and confirms it
 * is dropped; a ranking test confirms the ordering rewards movement, not
 * raw size.
 */

function binanceRow(symbol: string, overrides: Partial<{ price: number; volume: number; changePct: number }> = {}) {
  return {
    symbol,
    lastPrice: String(overrides.price ?? 1),
    quoteVolume: String(overrides.volume ?? 50_000_000),
    priceChangePercent: String(overrides.changePct ?? 10),
  };
}

function geckoRow(symbol: string, overrides: Partial<{ marketCap: number; rank: number }> = {}) {
  return {
    symbol: symbol.replace(/USDT$/, "").toLowerCase(),
    market_cap: overrides.marketCap ?? 500_000_000,
    total_volume: 50_000_000,
    price_change_percentage_24h: 10,
    current_price: 1,
    market_cap_rank: overrides.rank ?? 50,
  };
}

/** `binanceRows` supplies the exchange-side stats; `geckoRows` supplies the
 * market caps CoinGecko contributes. A symbol with no matching gecko row has
 * no market cap and so cannot pass `topMarkets`'s legitimacy floor. */
function stubFetch(binanceRows: ReturnType<typeof binanceRow>[], geckoRows: ReturnType<typeof geckoRow>[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("binance")) return new Response(JSON.stringify(binanceRows), { status: 200 });
    if (url.includes("coingecko")) {
      const page = new URL(url).searchParams.get("page");
      return new Response(JSON.stringify(page === "1" ? geckoRows : []), { status: 200 });
    }
    return new Response(JSON.stringify({ result: { list: [] } }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** A symbol with matching rows on both sides, ready to pass every filter
 * unless a test overrides one side to make it fail. */
function passingSetup(overrides: { symbol?: string; volume?: number; changePct?: number; marketCap?: number } = {}) {
  const symbol = overrides.symbol ?? "FOOUSDT";
  return {
    binance: [binanceRow(symbol, { volume: overrides.volume, changePct: overrides.changePct })],
    gecko: [geckoRow(symbol, { marketCap: overrides.marketCap })],
  };
}

describe("isTradeableBase", () => {
  it("rejects a stablecoin priced against USDT", () => {
    expect(isTradeableBase("USDCUSDT")).toBe(false);
    expect(isTradeableBase("FDUSDUSDT")).toBe(false);
  });

  it("accepts an ordinary asset", () => {
    expect(isTradeableBase("BTCUSDT")).toBe(true);
    expect(isTradeableBase("SOLUSDT")).toBe(true);
  });
});

describe("CexScreener.topMarkets — filters", () => {
  it("accepts a coin that clears every gate", async () => {
    const { binance, gecko } = passingSetup();
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    const top = await screener.topMarkets();
    expect(top.map((t) => t.symbol)).toEqual(["FOOUSDT"]);
  });

  it("excludes a coin with no market cap at all — the legitimacy floor requires one", async () => {
    const { binance } = passingSetup(); // no matching gecko row supplied
    const screener = new CexScreener({ fetchFn: stubFetch(binance, []) });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("rejects a coin below the market-cap floor even with plenty of volume and movement", async () => {
    const { binance, gecko } = passingSetup({ marketCap: DEFAULT_SCREENER_FILTERS.minMarketCapUsd - 1 });
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("rejects a coin below the volume floor", async () => {
    const { binance, gecko } = passingSetup({ volume: DEFAULT_SCREENER_FILTERS.minQuoteVolume24hUsd - 1 });
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("rejects a coin that barely moved — the entire point of this ranking is to skip those", async () => {
    const { binance, gecko } = passingSetup({ changePct: DEFAULT_SCREENER_FILTERS.minPriceChangePct24h - 0.5 });
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("rejects a coin that moved further than the sane parabolic-pump ceiling", async () => {
    const { binance, gecko } = passingSetup({ changePct: DEFAULT_SCREENER_FILTERS.maxPriceChangePct24h + 10 });
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("rejects a stablecoin-to-stablecoin pair even if it somehow had a market cap and volume", async () => {
    const { binance, gecko } = passingSetup({ symbol: "USDCUSDT" });
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    expect(await screener.topMarkets()).toEqual([]);
  });

  it("does not cap the number of results by default — every coin clearing the filters is returned", async () => {
    const symbols = Array.from({ length: 40 }, (_, i) => `TOK${i}USDT`);
    const binance = symbols.map((s) => binanceRow(s));
    const gecko = symbols.map((s) => geckoRow(s));
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    expect(await screener.topMarkets()).toHaveLength(40);
  });

  it("still respects an explicit limit when one is given", async () => {
    const symbols = Array.from({ length: 40 }, (_, i) => `TOK${i}USDT`);
    const binance = symbols.map((s) => binanceRow(s));
    const gecko = symbols.map((s) => geckoRow(s));
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    expect(await screener.topMarkets({ limit: 5 })).toHaveLength(5);
  });
});

describe("CexScreener.topMarkets — ranking", () => {
  it("ranks a smaller, more volatile coin above a mega-cap that barely moved", async () => {
    const binance = [
      binanceRow("BIGUSDT", { volume: 900_000_000, changePct: 4 }), // clears the movement floor, but only just
      binanceRow("SMALLUSDT", { volume: 20_000_000, changePct: 25 }), // real move, real activity
    ];
    const gecko = [
      geckoRow("BIGUSDT", { marketCap: 1_000_000_000_000, rank: 1 }),
      geckoRow("SMALLUSDT", { marketCap: 500_000_000, rank: 120 }),
    ];
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    const top = await screener.topMarkets();
    expect(top.map((t) => t.symbol)).toEqual(["SMALLUSDT", "BIGUSDT"]);
  });

  it("ranks by movement relative to size, not raw volume", async () => {
    // Same market cap; A has more absolute volume, but B moved more and has
    // higher volume relative to its own cap.
    const binance = [
      binanceRow("AUSDT", { volume: 100_000_000, changePct: 5 }),
      binanceRow("BUSDT", { volume: 60_000_000, changePct: 20 }),
    ];
    const gecko = [geckoRow("AUSDT", { marketCap: 500_000_000 }), geckoRow("BUSDT", { marketCap: 500_000_000 })];
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    const top = await screener.topMarkets();
    expect(top.map((t) => t.symbol)).toEqual(["BUSDT", "AUSDT"]);
  });

  it("computes movementScore as |24h change| times volume-to-cap turnover", async () => {
    const { binance, gecko } = passingSetup({ volume: 100_000_000, changePct: 10, marketCap: 500_000_000 });
    const screener = new CexScreener({ fetchFn: stubFetch(binance, gecko) });
    const [top] = await screener.topMarkets();
    expect(top!.movementScore).toBeCloseTo(10 * (100_000_000 / 500_000_000), 6);
  });
});

describe("CexScreener — exchange aggregation and resilience", () => {
  it("falls back to bybit when binance's bulk endpoint fails", async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("binance")) throw new Error("network down");
      if (url.includes("bybit")) {
        return new Response(
          JSON.stringify({ result: { list: [{ symbol: "ETHUSDT", lastPrice: "3000", turnover24h: "80000000", price24hPcnt: "0.1" }] } }),
          { status: 200 },
        );
      }
      if (url.includes("coingecko")) {
        const page = new URL(url).searchParams.get("page");
        return new Response(JSON.stringify(page === "1" ? [geckoRow("ETHUSDT")] : []), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const screener = new CexScreener({ fetchFn });
    const top = await screener.topMarkets();
    expect(top).toHaveLength(1);
    expect(top[0]!.symbol).toBe("ETHUSDT");
    expect(top[0]!.priceChangePct24h).toBeCloseTo(10, 6);
  });

  it("parses OKX's bulk tickers, converting its instId and computing 24h change from open24h", async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("okx")) {
        return new Response(
          JSON.stringify({ data: [{ instId: "BTC-USDT", last: "63000", open24h: "60000", volCcy24h: "500000000" }] }),
          { status: 200 },
        );
      }
      if (url.includes("coingecko")) {
        const page = new URL(url).searchParams.get("page");
        return new Response(JSON.stringify(page === "1" ? [geckoRow("BTCUSDT", { marketCap: 1_000_000_000_000 })] : []), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const screener = new CexScreener({ exchanges: ["okx"], fetchFn });
    const top = await screener.topMarkets();
    expect(top).toHaveLength(1);
    expect(top[0]!.symbol).toBe("BTCUSDT");
    expect(top[0]!.priceChangePct24h).toBeCloseTo(5, 6); // 63000 vs 60000 open
    expect(top[0]!.sources).toEqual(["okx"]);
  });

  it("aggregates every exchange at once rather than stopping at the first success", async () => {
    const binance = [binanceRow("BTCUSDT", { volume: 900_000_000 })];
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("binance")) return new Response(JSON.stringify(binance), { status: 200 });
      if (url.includes("bybit")) {
        return new Response(
          JSON.stringify({ result: { list: [{ symbol: "SOLUSDT", lastPrice: "150", turnover24h: "30000000", price24hPcnt: "0.15" }] } }),
          { status: 200 },
        );
      }
      if (url.includes("coingecko")) {
        const page = new URL(url).searchParams.get("page");
        return new Response(JSON.stringify(page === "1" ? [geckoRow("BTCUSDT", { marketCap: 1_000_000_000_000 }), geckoRow("SOLUSDT")] : []), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const screener = new CexScreener({ exchanges: ["binance", "bybit"], fetchFn });
    const top = await screener.topMarkets();
    expect(top.map((t) => t.symbol).sort()).toEqual(["BTCUSDT", "SOLUSDT"]);
  });

  it("merges a symbol both exchanges list, keeping the higher-volume reading and recording both sources", async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("binance")) return new Response(JSON.stringify([binanceRow("BTCUSDT", { volume: 900_000_000 })]), { status: 200 });
      if (url.includes("bybit")) {
        return new Response(
          JSON.stringify({ result: { list: [{ symbol: "BTCUSDT", lastPrice: "63010", turnover24h: "1200000000", price24hPcnt: "0.1" }] } }),
          { status: 200 },
        );
      }
      if (url.includes("coingecko")) {
        const page = new URL(url).searchParams.get("page");
        return new Response(JSON.stringify(page === "1" ? [geckoRow("BTCUSDT", { marketCap: 1_000_000_000_000 })] : []), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const screener = new CexScreener({ exchanges: ["binance", "bybit"], fetchFn });
    const top = await screener.topMarkets();
    expect(top).toHaveLength(1);
    expect(top[0]!.quoteVolume24hUsd).toBe(1_200_000_000); // bybit's higher figure wins
    expect(top[0]!.sources.sort()).toEqual(["binance", "bybit"]);
  });

  it("throws when every exchange fails, naming each failure", async () => {
    const screener = new CexScreener({
      fetchFn: (async (input: string | URL) => {
        if (String(input).includes("coingecko")) return new Response("[]", { status: 200 });
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    await expect(screener.topMarkets()).rejects.toThrow(/binance.*down.*bybit.*down.*okx.*down/s);
  });

  it("does not fail outright when CoinGecko itself is unreachable — readings just carry a null market cap", async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("coingecko")) throw new Error("coingecko down");
      return stubFetch([binanceRow("BTCUSDT")], [])(input as never);
    }) as unknown as typeof fetch;
    const screener = new CexScreener({ fetchFn });
    const all = await screener.allStats();
    expect(all[0]!.marketCapUsd).toBeNull();
    expect(all[0]!.movementScore).toBeNull();
    // topMarkets still excludes it, correctly, since it cannot judge legitimacy.
    expect(await screener.topMarkets({ stats: all })).toEqual([]);
  });

  it("ignores an exchange passed in that has no bulk stats source", async () => {
    const screener = new CexScreener({ exchanges: ["kucoin"] });
    await expect(screener.topMarkets()).rejects.toThrow();
  });
});

describe("news-driven symbol lookup", () => {
  const stats = [
    { symbol: "BTCUSDT", priceUsd: 63_000, quoteVolume24hUsd: 900_000_000, priceChangePct24h: 2, sources: ["binance"] as const, marketCapUsd: 1_000_000_000_000, movementScore: 0.002 },
    { symbol: "TINYUSDT", priceUsd: 0.02, quoteVolume24hUsd: 3_000_000, priceChangePct24h: 5, sources: ["binance"] as const, marketCapUsd: null, movementScore: null },
    { symbol: "DEADUSDT", priceUsd: 0.001, quoteVolume24hUsd: 100_000, priceChangePct24h: 1, sources: ["binance"] as const, marketCapUsd: null, movementScore: null },
    { symbol: "PUMPUSDT", priceUsd: 1, quoteVolume24hUsd: 5_000_000, priceChangePct24h: 90, sources: ["binance"] as const, marketCapUsd: null, movementScore: null },
    { symbol: "USDCUSDT", priceUsd: 1, quoteVolume24hUsd: 50_000_000, priceChangePct24h: 0, sources: ["binance"] as const, marketCapUsd: null, movementScore: null },
  ];

  it("finds a news-mentioned symbol below the normal top-markets volume floor", async () => {
    const screener = new CexScreener();
    const result = screener.bySymbol(stats, ["TINYUSDT"]);
    expect(result.map((r) => r.symbol)).toEqual(["TINYUSDT"]);
  });

  it("still rejects a symbol below even the reduced news floor", async () => {
    const screener = new CexScreener();
    expect(screener.bySymbol(stats, ["DEADUSDT"])).toEqual([]);
  });

  it("still rejects a symbol moving too fast to be a stable read", async () => {
    const screener = new CexScreener();
    expect(screener.bySymbol(stats, ["PUMPUSDT"])).toEqual([]);
  });

  it("still rejects a stablecoin pair even if a headline names it", async () => {
    const screener = new CexScreener();
    expect(screener.bySymbol(stats, ["USDCUSDT"])).toEqual([]);
  });

  it("ignores a symbol not present in the stats at all, rather than inventing one", async () => {
    const screener = new CexScreener();
    expect(screener.bySymbol(stats, ["NOTLISTEDUSDT"])).toEqual([]);
  });

  it("a news lookup does not require a market cap — that floor is topMarkets-only", async () => {
    const screener = new CexScreener();
    const result = screener.bySymbol(stats, ["TINYUSDT"]);
    expect(result[0]!.marketCapUsd).toBeNull();
  });

  it("topMarkets accepts already-fetched stats, avoiding a second network round-trip", async () => {
    let calls = 0;
    const fetchFn = (async (input: string | URL) => {
      calls++;
      return stubFetch([binanceRow("BTCUSDT")], [geckoRow("BTCUSDT", { marketCap: 1_000_000_000_000 })])(input as never);
    }) as unknown as typeof fetch;
    const screener = new CexScreener({ fetchFn });
    const all = await screener.allStats();
    const callsAfterFirst = calls;
    await screener.topMarkets({ stats: all });
    expect(calls).toBe(callsAfterFirst);
  });
});
