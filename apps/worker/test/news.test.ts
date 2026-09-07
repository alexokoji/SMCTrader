import { describe, expect, it, vi } from "vitest";
import {
  cautionSymbols,
  classifySentiment,
  fetchNews,
  parseRss,
  symbolsMentioned,
} from "../src/news.js";

const UNIVERSE = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT"];

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Bitcoin ETF sees record inflow</title><link>https://x/1</link><pubDate>Wed, 20 Aug 2026 08:00:00 GMT</pubDate></item>
<item><title><![CDATA[Major exchange hack drains Solana funds]]></title><link>https://x/2</link><pubDate>Wed, 20 Aug 2026 07:00:00 GMT</pubDate></item>
<item><title>Ethereum upgrade ships on schedule</title><link>https://x/3</link><pubDate>Wed, 20 Aug 2026 06:00:00 GMT</pubDate></item>
</channel></rss>`;

describe("sentiment", () => {
  it("reads risk words as negative", () => {
    expect(classifySentiment("Exchange hack drains user funds")).toBe("NEGATIVE");
    expect(classifySentiment("Regulator announces crackdown")).toBe("NEGATIVE");
  });

  it("reads adoption words as positive", () => {
    expect(classifySentiment("Spot ETF approval clears final hurdle")).toBe("POSITIVE");
  });

  it("treats a mixed headline as negative, since risk dominates sizing", () => {
    expect(classifySentiment("ETF approval overshadowed by exchange hack")).toBe("NEGATIVE");
  });

  it("defaults to neutral rather than guessing", () => {
    expect(classifySentiment("Weekly market wrap for traders")).toBe("NEUTRAL");
  });
});

describe("symbol matching", () => {
  it("maps coin names to the traded market", () => {
    expect(symbolsMentioned("Bitcoin rallies past resistance", UNIVERSE)).toEqual(["BTCUSDT"]);
    expect(symbolsMentioned("Solana and Ethereum both gain", UNIVERSE)).toEqual(
      expect.arrayContaining(["SOLUSDT", "ETHUSDT"]),
    );
  });

  it("does not match a ticker inside another word", () => {
    // "solar" must not match SOL.
    expect(symbolsMentioned("Solar mining farms expand", UNIVERSE)).toEqual([]);
  });

  it("returns nothing for a headline about no tracked market", () => {
    expect(symbolsMentioned("Central bank holds rates", UNIVERSE)).toEqual([]);
  });
});

describe("parseRss", () => {
  it("extracts titles, links and dates", () => {
    const items = parseRss(RSS, "TestFeed", UNIVERSE);
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe("Bitcoin ETF sees record inflow");
    expect(items[0].url).toBe("https://x/1");
    expect(items[0].source).toBe("TestFeed");
    expect(items[0].publishedAt).toBeGreaterThan(0);
  });

  it("unwraps CDATA and tags each item", () => {
    const items = parseRss(RSS, "TestFeed", UNIVERSE);
    expect(items[1].title).toBe("Major exchange hack drains Solana funds");
    expect(items[1].sentiment).toBe("NEGATIVE");
    expect(items[1].symbols).toEqual(["SOLUSDT"]);
  });
});

describe("fetchNews", () => {
  it("merges feeds, de-duplicates and sorts newest first", async () => {
    const fetchFn = vi.fn(async () => new Response(RSS, { status: 200 }));
    const result = await fetchNews(UNIVERSE, { fetchFn: fetchFn as unknown as typeof fetch });

    expect(result.unavailable).toBe(false);
    // Three feeds return identical items; duplicates collapse to three.
    expect(result.items).toHaveLength(3);
    expect(result.items[0].publishedAt).toBeGreaterThanOrEqual(result.items[1].publishedAt);
    expect(result.sources.every((s) => s.ok)).toBe(true);
  });

  it("reports unavailability rather than showing an empty list as calm markets", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("DNS failure"); });
    const result = await fetchNews(UNIVERSE, { fetchFn: fetchFn as unknown as typeof fetch });

    expect(result.unavailable).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.sources.every((s) => !s.ok)).toBe(true);
    expect(result.sources[0].detail).toMatch(/DNS failure/);
  });

  it("keeps working when only some feeds respond", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call++;
      if (call === 1) return new Response("nope", { status: 503 });
      return new Response(RSS, { status: 200 });
    });
    const result = await fetchNews(UNIVERSE, { fetchFn: fetchFn as unknown as typeof fetch });

    expect(result.unavailable).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.sources.filter((s) => s.ok).length).toBe(2);
  });
});

describe("cautionSymbols", () => {
  const now = Date.parse("2026-08-20T10:00:00Z");

  it("flags markets with recent negative coverage", () => {
    const items = parseRss(RSS, "T", UNIVERSE).map((i) => ({ ...i, publishedAt: now - 3_600_000 }));
    expect(cautionSymbols(items, 6 * 3_600_000, now)).toEqual(["SOLUSDT"]);
  });

  it("ignores coverage that is no longer recent", () => {
    const items = parseRss(RSS, "T", UNIVERSE).map((i) => ({ ...i, publishedAt: now - 48 * 3_600_000 }));
    expect(cautionSymbols(items, 6 * 3_600_000, now)).toEqual([]);
  });

  it("never flags a market on positive news", () => {
    const items = parseRss(RSS, "T", UNIVERSE)
      .filter((i) => i.sentiment === "POSITIVE")
      .map((i) => ({ ...i, publishedAt: now }));
    expect(cautionSymbols(items, 6 * 3_600_000, now)).toEqual([]);
  });
});
