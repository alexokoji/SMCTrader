/**
 * End-to-end smoke test against live public market data.
 *
 * Answers one question directly: given real candles right now, does the engine
 * produce setups, and does it open paper positions? Run with:
 *
 *   npx tsx apps/worker/test/smoke.ts [SYMBOL...]
 *
 * It uses the same TradingRuntime the Worker uses, in PAPER mode with auto
 * trading enabled, so a result here reflects production behaviour.
 */
import { TradingRuntime, type RuntimeStorage } from "../src/runtime.js";
import type { Timeframe } from "@smc/core";

const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const SYMBOLS = args.filter((a) => !a.startsWith("--")).length
  ? args.filter((a) => !a.startsWith("--"))
  : ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

const HOUR = 3_600_000;

/**
 * Offline candles with real structure: an impulse, a pullback into the origin
 * of that impulse, then continuation. This shape is what the engine is built to
 * find, so it exercises the execution path when exchange APIs are unreachable.
 */
function syntheticSeries(tf: Timeframe, count: number, stepMs: number, endTs: number, seedBase: number) {
  let seed = seedBase;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let price = 100_000;
  const out = [];
  for (let i = 0; i < count; i++) {
    const cycle = i % 40;
    // Impulse up, pull back into the prior range, then continue.
    const drift = cycle < 22 ? 260 + rnd() * 120 : cycle < 32 ? -230 - rnd() * 110 : 210 + rnd() * 130;
    const open = price;
    const close = open + drift;
    const wick = 40 + rnd() * 120;
    out.push({
      symbol: "SMOKE",
      exchange: "offline",
      timeframe: tf,
      timestamp: endTs - (count - 1 - i) * stepMs,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: 100 + rnd() * 40,
    });
    price = close;
  }
  return out;
}

function offlineFetch(now: number): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const interval = url.searchParams.get("interval") ?? "1h";
    const tf: Timeframe = interval === "4h" ? "4H" : interval === "1h" ? "1H" : "15M";
    const step = tf === "4H" ? 4 * HOUR : tf === "1H" ? HOUR : HOUR / 4;
    const rows = syntheticSeries(tf, 240, step, now, tf === "4H" ? 11 : tf === "1H" ? 23 : 31).map((c) => [
      c.timestamp, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume),
    ]);
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
}

function memoryStorage(): RuntimeStorage {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async put(entries: Record<string, unknown>) {
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
  };
}

function line(char = "─"): string {
  return char.repeat(74);
}

async function main(): Promise<void> {
  console.log(line("="));
  console.log(`SMC ENGINE SMOKE TEST — ${OFFLINE ? "OFFLINE synthetic candles" : "live public market data"}, PAPER mode, auto trading ON`);
  if (OFFLINE) {
    console.log("!! Offline mode: structure is synthetic. This proves the pipeline");
    console.log("!! executes, NOT what the engine would do on today's real market.");
  }
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(line("="));

  const now = Date.now();
  const runtime = new TradingRuntime(
    memoryStorage(),
    OFFLINE ? { fetchFn: offlineFetch(now) } : {},
  );
  const opts = {
    mode: "PAPER" as const,
    risk: {},
    autoTrading: true,
    safetyBlocked: false,
  };

  for (const symbol of SYMBOLS) {
    console.log(`\n${line()}\n${symbol}\n${line()}`);
    const started = Date.now();

    let tick;
    let ticks = 0;
    try {
      // Warm the engine fully, exactly as successive cron ticks would.
      do {
        tick = await runtime.tick(symbol, opts);
        ticks++;
      } while (tick.warming && ticks < 40);
    } catch (error) {
      console.log(`  MARKET DATA FAILED: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const engine = runtime.engineFor(symbol)!;
    const analysis = tick.analysis;
    const cfg = engine.strategyConfig;

    const candleCounts = [cfg.timeframes.htf, cfg.timeframes.mtf, cfg.timeframes.ltf]
      .map((tf) => `${tf}=${engine.analysis.candlesFor(tf).length}`)
      .join(" ");

    console.log(`  provider        : ${tick.exchange}`);
    console.log(`  warm-up ticks   : ${ticks} (${Date.now() - started}ms wall clock)`);
    console.log(`  candles fed     : ${candleCounts}`);
    console.log(`  bias            : ${analysis.bias}`);
    console.log(`  engine status   : ${tick.status}`);
    console.log(`  top-down        : HTF ${analysis.topDown.htf.trend} / MTF ${analysis.topDown.mtf.trend} / LTF ${analysis.topDown.ltf.trend}`);
    if (analysis.topDown.conflict) console.log(`  conflict        : ${analysis.topDown.conflict}`);

    const setups = analysis.setups;
    console.log(`  setups produced : ${setups.length}`);

    const byStatus = new Map<string, number>();
    for (const setup of setups) byStatus.set(setup.status, (byStatus.get(setup.status) ?? 0) + 1);
    for (const [status, count] of byStatus) console.log(`      ${status.padEnd(12)} ${count}`);

    // Which mandatory condition is blocking? This is the actual answer to
    // "why is it not trading".
    const failedRules = new Map<string, number>();
    for (const setup of setups) {
      for (const rule of setup.hardRules ?? []) {
        if (rule.status === "FAIL") failedRules.set(rule.name, (failedRules.get(rule.name) ?? 0) + 1);
      }
      for (const reason of setup.rejectionReasons) {
        failedRules.set(reason, (failedRules.get(reason) ?? 0) + 1);
      }
    }
    if (failedRules.size) {
      console.log("  blocking reasons:");
      for (const [reason, count] of [...failedRules.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${String(count).padStart(3)}x  ${reason}`);
      }
    }

    const positions = engine.getPositions();
    const risk = engine.getRiskState();
    console.log(`  positions opened: ${positions.length} (${engine.getOpenPositions().length} open)`);
    for (const p of positions) {
      console.log(`      ${p.direction} ${p.symbol} entry=${p.entry.toFixed(2)} sl=${p.sl.toFixed(2)} size=${p.positionSize} status=${p.status}`);
    }
    console.log(`  equity          : ${risk.equity.toFixed(2)}  tradesToday=${risk.tradesToday}`);
    console.log(`  auto trading    : ${engine.isAutoTrading()}   safeMode=${engine.isSafetyBlocked()}`);

    const activity = engine.getActivity().getAll().slice(0, 6);
    if (activity.length) {
      console.log("  recent activity :");
      for (const event of activity) console.log(`      [${event.level}] ${event.kind}: ${event.detail}`);
    }
  }

  console.log(`\n${line("=")}`);
  console.log("Interpretation:");
  console.log("  'setups produced: 0' with a clear bias means the engine found no valid");
  console.log("  point of interest yet — that is a normal outcome, not a failure.");
  console.log("  'positions opened: 0' with valid setups means risk or a hard rule blocked");
  console.log("  execution; the blocking reasons above name which one.");
  console.log(line("="));
}

void main();
