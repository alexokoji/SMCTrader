/**
 * Crypto news.
 *
 * News is context, never a trade trigger. Nothing here produces a signal: the
 * feed is surfaced to the operator, and a headline can only ever make an agent
 * more cautious (by marking a market as event-sensitive), never more willing.
 *
 * Sources are public RSS/JSON endpoints requiring no key. If they are all
 * unreachable the caller is told so plainly rather than shown an empty list
 * that looks like calm markets.
 */

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  /** Symbols the headline plausibly concerns, uppercased. */
  symbols: string[];
  /** Words that raise or lower risk, used only to flag caution. */
  sentiment: "NEGATIVE" | "NEUTRAL" | "POSITIVE";
}

export interface NewsResult {
  items: NewsItem[];
  fetchedAt: number;
  sources: { name: string; ok: boolean; detail?: string }[];
  /** True when no source could be reached, so an empty list is not mistaken
   * for an absence of news. */
  unavailable: boolean;
}

const FEEDS: { name: string; url: string }[] = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

const NEGATIVE = [
  "hack", "exploit", "breach", "lawsuit", "sue", "ban", "crackdown", "collapse",
  "bankrupt", "insolvent", "liquidation", "crash", "plunge", "sell-off", "selloff",
  "fraud", "investigation", "delist", "outage", "halt", "sanction",
];
const POSITIVE = [
  "approval", "approved", "etf", "adoption", "partnership", "upgrade", "rally",
  "surge", "record high", "inflow", "institutional", "listing", "integration",
];

/** Ticker aliases so a headline naming a coin maps to the traded market. */
const SYMBOL_WORDS: Record<string, string[]> = {
  BTCUSDT: ["bitcoin", "btc"],
  ETHUSDT: ["ethereum", "ether", "eth"],
  SOLUSDT: ["solana", "sol"],
  XRPUSDT: ["ripple", "xrp"],
  BNBUSDT: ["binance coin", "bnb"],
  ADAUSDT: ["cardano", "ada"],
  DOGEUSDT: ["dogecoin", "doge"],
  LINKUSDT: ["chainlink", "link"],
};

export function classifySentiment(title: string): NewsItem["sentiment"] {
  const lower = title.toLowerCase();
  const negative = NEGATIVE.some((word) => lower.includes(word));
  const positive = POSITIVE.some((word) => lower.includes(word));
  // A headline carrying both reads as negative: risk dominates for position
  // sizing decisions.
  if (negative) return "NEGATIVE";
  if (positive) return "POSITIVE";
  return "NEUTRAL";
}

export function symbolsMentioned(title: string, universe: string[]): string[] {
  const lower = title.toLowerCase();
  return universe.filter((symbol) => {
    const words = SYMBOL_WORDS[symbol] ?? [symbol.replace(/USDT$/, "").toLowerCase()];
    return words.some((word) => new RegExp(`\\b${word}\\b`).test(lower));
  });
}

/** Minimal RSS extraction: titles, links and dates, without an XML dependency. */
export function parseRss(xml: string, source: string, universe: string[]): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks.slice(0, 30)) {
    const title = decodeXml(pick(block, "title"));
    const link = decodeXml(pick(block, "link"));
    const date = pick(block, "pubDate") || pick(block, "dc:date");
    if (!title) continue;
    const publishedAt = date ? Date.parse(date) : Number.NaN;
    items.push({
      id: `${source}:${title}`.slice(0, 200),
      title,
      url: link,
      source,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      symbols: symbolsMentioned(title, universe),
      sentiment: classifySentiment(title),
    });
  }
  return items;
}

function pick(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return "";
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export async function fetchNews(
  universe: string[],
  opts: { fetchFn?: typeof fetch; limit?: number } = {},
): Promise<NewsResult> {
  const doFetch = opts.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const sources: NewsResult["sources"] = [];
  const items: NewsItem[] = [];

  for (const feed of FEEDS) {
    try {
      const response = await doFetch(feed.url, { signal: AbortSignal.timeout(6_000) });
      if (!response.ok) {
        sources.push({ name: feed.name, ok: false, detail: `HTTP ${response.status}` });
        continue;
      }
      const parsed = parseRss(await response.text(), feed.name, universe);
      items.push(...parsed);
      sources.push({ name: feed.name, ok: true, detail: `${parsed.length} items` });
    } catch (error) {
      sources.push({
        name: feed.name,
        ok: false,
        detail: error instanceof Error ? error.message : "request failed",
      });
    }
  }

  const seen = new Set<string>();
  const deduped = items
    .filter((item) => {
      const key = item.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, opts.limit ?? 40);

  return {
    items: deduped,
    fetchedAt: Date.now(),
    sources,
    unavailable: sources.every((s) => !s.ok),
  };
}

/**
 * Markets carrying recent negative coverage. Used to make an agent more
 * cautious, never to open a position.
 */
export function cautionSymbols(news: NewsItem[], withinMs = 6 * 3_600_000, now = Date.now()): string[] {
  const flagged = new Set<string>();
  for (const item of news) {
    if (item.sentiment !== "NEGATIVE") continue;
    if (now - item.publishedAt > withinMs) continue;
    for (const symbol of item.symbols) flagged.add(symbol);
  }
  return [...flagged];
}
