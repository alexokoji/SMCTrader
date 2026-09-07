var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { DurableObject } from "cloudflare:workers";

// ../../packages/core/src/types/candles.ts
var TIMEFRAME_DURATION_MS = {
  "5M": 5 * 60 * 1e3,
  "15M": 15 * 60 * 1e3,
  "30M": 30 * 60 * 1e3,
  "1H": 60 * 60 * 1e3,
  "2H": 2 * 60 * 60 * 1e3,
  "4H": 4 * 60 * 60 * 1e3,
  "1D": 24 * 60 * 60 * 1e3
};
function timeframeDuration(tf) {
  return TIMEFRAME_DURATION_MS[tf];
}
__name(timeframeDuration, "timeframeDuration");

// ../../packages/core/src/config/platform.ts
var PLATFORM_LIMITS = {
  /** Absolute maximum trades per day (1-15). Enforced by the backend regardless of input. */
  maxTradesPerDay: 15,
  /** Minimum RR a trade must project. */
  minRr: 1,
  /** Risk per trade in percent of equity (0.1% .. 5%). */
  riskPerTradeMin: 0.1,
  riskPerTradeMax: 5,
  /** Daily loss limit in percent (0.5% .. 10%). */
  dailyLossMin: 0.5,
  dailyLossMax: 10,
  /** Max drawdown in percent (2% .. 50%). */
  maxDrawdownMin: 2,
  maxDrawdownMax: 50,
  /** Maximum leverage. */
  maxLeverage: 125,
  /** Maximum open positions. */
  maxOpenPositions: 25,
  /** Maximum portfolio exposure in percent of equity. */
  maxPortfolioExposureMax: 1e3,
  /** Maximum symbol exposure in percent of equity. */
  maxSymbolExposureMax: 500,
  /** Maximum correlated-group directional exposure in percent of equity. */
  maxCorrelatedExposureMax: 400
};
function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
__name(clamp, "clamp");

// ../../packages/core/src/config/index.ts
function validateRiskConfig(cfg) {
  return {
    ...cfg,
    riskPerTrade: clamp(
      cfg.riskPerTrade,
      PLATFORM_LIMITS.riskPerTradeMin,
      PLATFORM_LIMITS.riskPerTradeMax
    ),
    maxDailyLossPct: clamp(
      cfg.maxDailyLossPct,
      PLATFORM_LIMITS.dailyLossMin,
      PLATFORM_LIMITS.dailyLossMax
    ),
    maxDrawdownPct: clamp(
      cfg.maxDrawdownPct,
      PLATFORM_LIMITS.maxDrawdownMin,
      PLATFORM_LIMITS.maxDrawdownMax
    ),
    maxOpenPositions: clamp(
      Math.floor(cfg.maxOpenPositions),
      1,
      PLATFORM_LIMITS.maxOpenPositions
    ),
    // CRITICAL: hard ceiling of 15 enforced regardless of frontend input.
    maxTradesPerDay: clamp(
      Math.floor(cfg.maxTradesPerDay),
      1,
      PLATFORM_LIMITS.maxTradesPerDay
    ),
    maxLeverage: clamp(
      cfg.maxLeverage,
      1,
      PLATFORM_LIMITS.maxLeverage
    ),
    maxPortfolioExposurePct: clamp(
      cfg.maxPortfolioExposurePct,
      1,
      PLATFORM_LIMITS.maxPortfolioExposureMax
    ),
    maxSymbolExposurePct: clamp(
      cfg.maxSymbolExposurePct,
      1,
      PLATFORM_LIMITS.maxSymbolExposureMax
    ),
    maxCorrelatedExposurePct: clamp(
      cfg.maxCorrelatedExposurePct,
      1,
      PLATFORM_LIMITS.maxCorrelatedExposureMax
    )
  };
}
__name(validateRiskConfig, "validateRiskConfig");
var DEFAULT_STRATEGY_CONFIG = {
  version: "smc-v1.0.0",
  name: "SMC Strategy",
  symbol: "BTCUSDT",
  exchange: "binance",
  timeframes: { htf: "4H", mtf: "1H", ltf: "15M" },
  entryModels: {
    aggressive: false,
    confirmation: true,
    sweep: true,
    counterTrend: false
  },
  minRr: 3,
  tp1MinRr: 1.5,
  swingStrength: 2,
  structureLookback: 300,
  displacementAtrMultiple: 1.5,
  atrPeriod: 14,
  equalLevelToleranceAtr: 0.15,
  setupMaxAgeMs: 1e3 * 60 * 60 * 8,
  entryTolerancePct: 1.5,
  inducementEnabled: true,
  premiumDiscountEnabled: true,
  requirePremiumDiscount: false,
  significantSwings: 3,
  partialClosePlan: [
    { targetIndex: 1, closePct: 50, moveSlToBreakEven: true },
    { targetIndex: 2, closePct: 25, moveSlToBreakEven: false }
  ],
  breakEvenOnTp1: true,
  counterTrendMinRrMultiplier: 1.5
};
var DEFAULT_RISK_CONFIG = {
  riskPerTrade: 1,
  maxDailyLossPct: 3,
  maxDrawdownPct: 10,
  maxOpenPositions: 5,
  maxTradesPerDay: 10,
  maxLeverage: 10,
  maxPortfolioExposurePct: 200,
  maxSymbolExposurePct: 50,
  maxCorrelatedExposurePct: 100,
  feePct: 0.04,
  slippagePct: 0.05,
  correlationGroups: {
    BTCUSDT: "major",
    ETHUSDT: "major",
    SOLUSDT: "major",
    BNBUSDT: "major",
    XRPUSDT: "major",
    DOGEUSDT: "major"
  }
};

// ../../packages/core/src/util.ts
function round(n, decimals = 8) {
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}
__name(round, "round");
function hashString(input) {
  let h1 = 3735928559;
  let h2 = 1103547991;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
  h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
  h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
__name(hashString, "hashString");
function trueRange(prevClose, high, low) {
  const a = high - low;
  const b = Math.abs(high - prevClose);
  const c = Math.abs(low - prevClose);
  return Math.max(a, b, c);
}
__name(trueRange, "trueRange");
function atr(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let prevClose = candles[0].close;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trueRange(prevClose, candles[i].high, candles[i].low);
    prevClose = candles[i].close;
  }
  let value = sum / period;
  out[period] = value;
  for (let i = period + 1; i < n; i++) {
    value = (value * (period - 1) + trueRange(prevClose, candles[i].high, candles[i].low)) / period;
    out[i] = value;
    prevClose = candles[i].close;
  }
  return out;
}
__name(atr, "atr");
function atrValue(candles, period, index) {
  const warmed = atr(candles, period)[index];
  if (Number.isFinite(warmed) && warmed > 0) return warmed;
  let sum = 0;
  let count = 0;
  let prevClose = candles[0]?.close;
  for (let i = 1; i <= index && i < candles.length; i++) {
    const c = candles[i];
    if (!c || prevClose == null) break;
    sum += trueRange(prevClose, c.high, c.low);
    count += 1;
    prevClose = c.close;
  }
  return count > 0 ? sum / count : 0;
}
__name(atrValue, "atrValue");

// ../../packages/core/src/engines/swing.ts
function detectSwings(candles, options) {
  const s = Math.max(1, Math.floor(options.strength));
  const n = candles.length;
  if (n < 2 * s + 1) return [];
  const atrs = atr(candles, 14);
  const swings = [];
  for (let i = s; i < n - s; i++) {
    const c = candles[i];
    if (!c) continue;
    let isHigh = true;
    let isLow = true;
    let adjacentHigh = -Infinity;
    let adjacentLow = Infinity;
    for (let j = i - s; j <= i + s; j++) {
      if (j === i) continue;
      const o = candles[j];
      if (!o) continue;
      if (o.high >= c.high) isHigh = false;
      if (o.low <= c.low) isLow = false;
      if (o.high > adjacentHigh) adjacentHigh = o.high;
      if (o.low < adjacentLow) adjacentLow = o.low;
    }
    const a = atrs[i] ?? NaN;
    const kind = isHigh && isLow ? null : isHigh ? "HIGH" : isLow ? "LOW" : null;
    if (kind) {
      let strengthVal = 0.5;
      if (Number.isFinite(a) && a > 0) {
        strengthVal = kind === "HIGH" ? clamp01((c.high - adjacentHigh) / a) : clamp01((adjacentLow - c.low) / a);
      }
      swings.push({
        index: i,
        timestamp: c.timestamp,
        price: kind === "HIGH" ? c.high : c.low,
        kind,
        strength: strengthVal
      });
    }
  }
  return swings;
}
__name(detectSwings, "detectSwings");
function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
__name(clamp01, "clamp01");

// ../../packages/core/src/engines/structure.ts
var EPS = 1e-12;
var MarketStructureEngine = class {
  static {
    __name(this, "MarketStructureEngine");
  }
  symbol;
  exchange;
  timeframe;
  candles = [];
  points = [];
  trend = "NEUTRAL";
  bosEvents = [];
  chochEvents = [];
  opts;
  lastBreakKey = "";
  lastEventIndex = -1;
  constructor(symbol, exchange, timeframe, opts) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = {
      strength: opts?.strength ?? 2,
      lookback: opts?.lookback ?? 300,
      maxHistory: opts?.maxHistory ?? 3e3
    };
  }
  update(candle) {
    if (this.candles.length > 0 && candle.timestamp <= this.candles[this.candles.length - 1].timestamp) {
      return;
    }
    this.candles.push(candle);
    if (this.candles.length > this.opts.maxHistory) {
      this.candles.splice(0, this.candles.length - this.opts.maxHistory);
    }
    this.recompute();
  }
  recompute() {
    const candles = this.candles;
    const n = candles.length;
    const window = candles.slice(-this.opts.lookback);
    const swings = detectSwings(window, { strength: this.opts.strength });
    const points = [];
    let lastHigh;
    let lastLow;
    for (const sw of swings) {
      let kind;
      let external = false;
      const candleIndex = n - window.length + sw.index;
      if (sw.kind === "HIGH") {
        kind = lastHigh ? sw.price > lastHigh.price + EPS ? "HH" : "LH" : "SWING_HIGH";
        external = lastHigh ? sw.price > lastHigh.price + EPS : false;
        lastHigh = {
          index: candleIndex,
          timestamp: sw.timestamp,
          price: sw.price,
          kind,
          external,
          createdAt: sw.timestamp
        };
        points.push(lastHigh);
      } else {
        kind = lastLow ? sw.price > lastLow.price + EPS ? "HL" : "LL" : "SWING_LOW";
        external = lastLow ? sw.price > lastLow.price + EPS : false;
        lastLow = {
          index: candleIndex,
          timestamp: sw.timestamp,
          price: sw.price,
          kind,
          external,
          createdAt: sw.timestamp
        };
        points.push(lastLow);
      }
    }
    this.points = points;
    this.updateTrend();
  }
  updateTrend() {
    const lows = this.points.filter((p) => p.kind.endsWith("L") || p.kind === "SWING_LOW");
    const highs = this.points.filter((p) => p.kind.endsWith("H") || p.kind === "SWING_HIGH");
    const lowKinds = lows.map((p) => p.kind);
    const highKinds = highs.map((p) => p.kind);
    const lastLowKinds = lowKinds.slice(-3);
    const lastHighKinds = highKinds.slice(-3);
    const lowsUp = lastLowKinds.filter((k) => k === "HL").length >= 2;
    const lowsDown = lastLowKinds.filter((k) => k === "LL").length >= 2;
    const highsUp = lastHighKinds.filter((k) => k === "HH").length >= 2;
    const highsDown = lastHighKinds.filter((k) => k === "LH").length >= 2;
    if ((lowsUp || highsUp) && !lowsDown && !highsDown) {
      this.trend = "BULLISH";
    } else if ((lowsDown || highsDown) && !lowsUp && !highsUp) {
      this.trend = "BEARISH";
    } else if (lowsUp && lowsDown) {
      this.trend = "RANGING";
    } else {
      this.trend = this.points.length < 4 ? "NEUTRAL" : "RANGING";
    }
  }
  /**
   * Detect BOS / CHoCH on the most recent candle close. Must be called after
   * update() with the same candle. Deterministic given the same history.
   */
  evaluate() {
    const events = [];
    const choch = [];
    const n = this.candles.length;
    if (n < 2) {
      return { state: this.toState(), bos: events, choch, snapshot: this.snapshot() };
    }
    const last = this.candles[n - 1];
    const close = last.close;
    const lastHigh = this.points.filter((p) => p.kind.endsWith("H") || p.kind === "SWING_HIGH").at(-1);
    const lastLow = this.points.filter((p) => p.kind.endsWith("L") || p.kind === "SWING_LOW").at(-1);
    const prevTrend = this.trend;
    if (lastHigh && close > lastHigh.price + EPS) {
      const key = `BOS_UP_${lastHigh.price.toFixed(8)}_${n - 1}`;
      if (key !== this.lastBreakKey || n - 1 > this.lastEventIndex + 60) {
        this.lastBreakKey = key;
        this.lastEventIndex = n - 1;
        events.push({
          type: "BOS_CONFIRMED",
          symbol: this.symbol,
          exchange: this.exchange,
          timeframe: this.timeframe,
          direction: "BULLISH",
          brokenLevel: lastHigh.price,
          confirmationPrice: close,
          candleIndex: n - 1,
          timestamp: last.timestamp,
          strength: prevTrend === "BULLISH" ? "STRONG" : "WEAK",
          previousStructure: prevTrend,
          resultingStructure: "BULLISH"
        });
      }
    }
    if (lastLow && close < lastLow.price - EPS) {
      const key = `BOS_DOWN_${lastLow.price.toFixed(8)}_${n - 1}`;
      if (key !== this.lastBreakKey || n - 1 > this.lastEventIndex + 60) {
        this.lastBreakKey = key;
        this.lastEventIndex = n - 1;
        events.push({
          type: "BOS_CONFIRMED",
          symbol: this.symbol,
          exchange: this.exchange,
          timeframe: this.timeframe,
          direction: "BEARISH",
          brokenLevel: lastLow.price,
          confirmationPrice: close,
          candleIndex: n - 1,
          timestamp: last.timestamp,
          strength: prevTrend === "BEARISH" ? "STRONG" : "WEAK",
          previousStructure: prevTrend,
          resultingStructure: "BEARISH"
        });
      }
    }
    if (prevTrend === "BULLISH" && lastLow && close < lastLow.price - EPS) {
      const sweepish = this.levelWasSwept(lastLow.price, "BEARISH", n - 1);
      choch.push({
        type: "CHOCH",
        symbol: this.symbol,
        exchange: this.exchange,
        timeframe: this.timeframe,
        direction: "BEARISH",
        brokenLevel: lastLow.price,
        confirmationPrice: close,
        candleIndex: n - 1,
        timestamp: last.timestamp,
        status: "CONFIRMED",
        causedBySweep: sweepish,
        previousTrend: "BULLISH",
        resultingTrend: "BEARISH"
      });
    } else if (prevTrend === "BEARISH" && lastHigh && close > lastHigh.price + EPS) {
      const sweepish = this.levelWasSwept(lastHigh.price, "BULLISH", n - 1);
      choch.push({
        type: "CHOCH",
        symbol: this.symbol,
        exchange: this.exchange,
        timeframe: this.timeframe,
        direction: "BULLISH",
        brokenLevel: lastHigh.price,
        confirmationPrice: close,
        candleIndex: n - 1,
        timestamp: last.timestamp,
        status: "CONFIRMED",
        causedBySweep: sweepish,
        previousTrend: "BEARISH",
        resultingTrend: "BULLISH"
      });
    }
    this.bosEvents.push(...events);
    this.chochEvents.push(...choch);
    return { state: this.toState(), bos: events, choch, snapshot: this.snapshot() };
  }
  /** true when price wick-traded beyond level (in direction) before the current close */
  levelWasSwept(level, direction, toIndex) {
    const start = Math.max(0, toIndex - 5);
    for (let i = start; i < toIndex; i++) {
      const c = this.candles[i];
      if (!c) continue;
      if (direction === "BULLISH" && c.high > level + EPS && c.close <= level + EPS) return true;
      if (direction === "BEARISH" && c.low < level - EPS && c.close >= level - EPS) return true;
    }
    return false;
  }
  get lastBosEvents() {
    return this.bosEvents.slice(-5);
  }
  get lastChochEvents() {
    return this.chochEvents.slice(-5);
  }
  toState() {
    const lastHigh = this.points.filter((p) => p.kind.endsWith("H") || p.kind === "SWING_HIGH").at(-1);
    const lastLow = this.points.filter((p) => p.kind.endsWith("L") || p.kind === "SWING_LOW").at(-1);
    const strong = this.points.filter((p) => (p.kind === "HH" || p.kind === "HL") && p.external).length + this.points.filter((p) => (p.kind === "LH" || p.kind === "LL") && p.external).length >= 4;
    return {
      symbol: this.symbol,
      exchange: this.exchange,
      timeframe: this.timeframe,
      points: this.points.slice(-40),
      trend: this.trend,
      strength: strong ? "STRONG" : "WEAK",
      lastSwingHigh: lastHigh,
      lastSwingLow: lastLow,
      updatedAt: this.candles.length ? this.candles[this.candles.length - 1].timestamp : 0
    };
  }
  snapshot() {
    const state = this.toState();
    const highs = state.points.filter((p) => p.kind.endsWith("H"));
    const lows = state.points.filter((p) => p.kind.endsWith("L"));
    return {
      trend: state.trend,
      strength: state.strength,
      sequence: [
        ...highs.slice(-2).map((p) => p.kind),
        ...lows.slice(-2).map((p) => p.kind)
      ],
      lastSwingHigh: state.lastSwingHigh ? { price: state.lastSwingHigh.price, timestamp: state.lastSwingHigh.timestamp } : void 0,
      lastSwingLow: state.lastSwingLow ? { price: state.lastSwingLow.price, timestamp: state.lastSwingLow.timestamp } : void 0
    };
  }
  getState() {
    return this.toState();
  }
  get candlesCount() {
    return this.candles.length;
  }
};

// ../../packages/core/src/engines/liquidity.ts
var LiquidityEngine = class {
  static {
    __name(this, "LiquidityEngine");
  }
  symbol;
  exchange;
  timeframe;
  candles = [];
  zones = [];
  opts;
  lastSwingIndex = -1;
  constructor(symbol, exchange, timeframe, opts) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = {
      strength: opts?.strength ?? 2,
      toleranceAtr: opts?.toleranceAtr ?? 0.15
    };
  }
  update(candle) {
    if (this.candles.length > 0 && candle.timestamp <= this.candles[this.candles.length - 1].timestamp) {
      return { zones: this.zones, sweeps: [] };
    }
    this.candles.push(candle);
    this.processSwings();
    return this.checkSweeps(candle);
  }
  tolerance(index) {
    const a = atr(this.candles, 14)[index];
    return Number.isFinite(a) && a > 0 ? a * this.opts.toleranceAtr : 0.01;
  }
  processSwings() {
    const swings = detectSwings(this.candles, { strength: this.opts.strength });
    for (const sw of swings) {
      if (sw.index <= this.lastSwingIndex) continue;
      this.lastSwingIndex = sw.index;
      this.addZoneFromSwing(sw);
    }
    this.prune();
  }
  addZoneFromSwing(sw) {
    const tol = this.tolerance(sw.index);
    if (sw.kind === "HIGH") {
      const existing = this.findNearby(sw.price, "BSL", tol);
      if (existing) {
        existing.interactions += 1;
        existing.source = "EQUAL_HIGH";
        existing.strength = Math.min(1, existing.strength + 0.15);
        if (sw.price > existing.level) existing.level = sw.price;
        existing.top = existing.level + tol;
        existing.bottom = existing.level - tol;
        return;
      }
      this.zones.push(this.buildZone(sw, "BSL", "SWING_HIGH", tol));
    } else {
      const existing = this.findNearby(sw.price, "SSL", tol);
      if (existing) {
        existing.interactions += 1;
        existing.source = "EQUAL_LOW";
        existing.strength = Math.min(1, existing.strength + 0.15);
        if (sw.price < existing.level) existing.level = sw.price;
        existing.top = existing.level + tol;
        existing.bottom = existing.level - tol;
        return;
      }
      this.zones.push(this.buildZone(sw, "SSL", "SWING_LOW", tol));
    }
  }
  buildZone(sw, type, source, tol) {
    const id = hashString(
      `${this.symbol}:${this.timeframe}:${type}:${sw.price.toFixed(8)}:${sw.timestamp}`
    );
    return {
      id,
      symbol: this.symbol,
      exchange: this.exchange,
      type,
      timeframe: this.timeframe,
      level: sw.price,
      top: sw.price + tol,
      bottom: sw.price - tol,
      source,
      createdAt: sw.timestamp,
      strength: Math.max(0.4, Math.min(1, sw.strength + 0.3)),
      status: "ACTIVE",
      interactions: 1
    };
  }
  findNearby(price, type, tol) {
    return this.zones.filter((z) => z.type === type && z.status !== "SWEPT").find((z) => Math.abs(z.level - price) <= tol * 1.5);
  }
  prune() {
    if (this.zones.length > 200) {
      this.zones = this.zones.slice(-200);
    }
  }
  checkSweeps(candle) {
    const sweeps = [];
    const index = this.candles.length - 1;
    for (const zone of this.zones) {
      if (zone.status === "SWEPT") continue;
      if (zone.type === "BSL") {
        if (candle.high >= zone.level) {
          zone.status = "SWEPT";
          zone.sweptAt = candle.timestamp;
          sweeps.push({
            type: "LIQUIDITY_SWEEP",
            symbol: this.symbol,
            exchange: this.exchange,
            timeframe: this.timeframe,
            direction: "SHORT",
            zoneId: zone.id,
            level: zone.level,
            extremePrice: candle.high,
            closePrice: candle.close,
            candleIndex: index,
            timestamp: candle.timestamp,
            rejected: candle.close < zone.level,
            structureShiftAfter: false
          });
        } else if (candle.high >= zone.bottom) {
          if (zone.status === "ACTIVE") {
            zone.status = "PARTIALLY_SWEPT";
            zone.interactions += 1;
          }
        }
      } else {
        if (candle.low <= zone.level) {
          zone.status = "SWEPT";
          zone.sweptAt = candle.timestamp;
          sweeps.push({
            type: "LIQUIDITY_SWEEP",
            symbol: this.symbol,
            exchange: this.exchange,
            timeframe: this.timeframe,
            direction: "LONG",
            zoneId: zone.id,
            level: zone.level,
            extremePrice: candle.low,
            closePrice: candle.close,
            candleIndex: index,
            timestamp: candle.timestamp,
            rejected: candle.close > zone.level,
            structureShiftAfter: false
          });
        } else if (candle.low <= zone.top) {
          if (zone.status === "ACTIVE") {
            zone.status = "PARTIALLY_SWEPT";
            zone.interactions += 1;
          }
        }
      }
    }
    return { zones: this.zones, sweeps };
  }
  getZones() {
    return this.zones;
  }
  activeZones() {
    return this.zones.filter((z) => z.status !== "SWEPT");
  }
  /** BSL levels resting above current price (potential long targets) */
  above(price) {
    return this.zones.filter((z) => z.type === "BSL" && z.level > price).sort((a, b) => a.level - b.level);
  }
  /** SSL levels resting below current price (potential short targets) */
  below(price) {
    return this.zones.filter((z) => z.type === "SSL" && z.level < price).sort((a, b) => b.level - a.level);
  }
};

// ../../packages/core/src/engines/fvg.ts
var FvgEngine = class {
  static {
    __name(this, "FvgEngine");
  }
  symbol;
  exchange;
  timeframe;
  candles = [];
  zones = [];
  opts;
  constructor(symbol, exchange, timeframe, opts) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = { maxZones: opts?.maxZones ?? 100 };
  }
  update(candle) {
    const created = [];
    const mitigated = [];
    if (this.candles.length > 0 && candle.timestamp <= this.candles[this.candles.length - 1].timestamp) {
      return { created, mitigated };
    }
    this.candles.push(candle);
    const n = this.candles.length;
    if (n >= 3) {
      const a = this.candles[n - 3];
      const c = this.candles[n - 1];
      if (a && c) {
        let fvg;
        if (a.high < c.low) {
          fvg = this.build("BULLISH", a.high, c.low, n - 1, c.timestamp);
        } else if (a.low > c.high) {
          fvg = this.build("BEARISH", c.high, a.low, n - 1, c.timestamp);
        }
        if (fvg) {
          created.push(fvg);
        }
      }
    }
    const current = this.candles[n - 1];
    for (const zone of this.zones) {
      if (zone.status === "MITIGATED") continue;
      if (current.high >= zone.bottom && current.low <= zone.top || current.low <= zone.bottom || current.high >= zone.top) {
        zone.status = "MITIGATED";
        zone.mitigatedAt = current.timestamp;
        mitigated.push(zone);
      }
    }
    if (this.zones.length > this.opts.maxZones) {
      this.zones = this.zones.slice(-this.opts.maxZones);
    }
    return { created, mitigated };
  }
  build(direction, bottom, top, candleIndex, timestamp) {
    const id = hashString(
      `${this.symbol}:${this.timeframe}:FVG:${bottom.toFixed(8)}:${top.toFixed(8)}:${timestamp}`
    );
    const zone = {
      id,
      symbol: this.symbol,
      exchange: this.exchange,
      timeframe: this.timeframe,
      direction,
      top,
      bottom,
      size: Math.abs(top - bottom),
      timestamp,
      candleIndex,
      status: "FRESH"
    };
    this.zones.push(zone);
    return zone;
  }
  getZones() {
    return this.zones;
  }
  /** fresh zones in the direction near price */
  fresh(direction, maxAgeMs) {
    const now = this.candles.length ? this.candles[this.candles.length - 1].timestamp : 0;
    return this.zones.filter(
      (z) => z.direction === direction && z.status === "FRESH" && now - z.timestamp < maxAgeMs
    );
  }
};

// ../../packages/core/src/engines/orderblock.ts
var OrderBlockEngine = class {
  static {
    __name(this, "OrderBlockEngine");
  }
  symbol;
  exchange;
  timeframe;
  candles = [];
  blocks = [];
  /** Candle index each block was created on, used to defer mitigation checks. */
  creationIndex = /* @__PURE__ */ new Map();
  opts;
  constructor(symbol, exchange, timeframe, opts) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = {
      displacementAtrMultiple: opts?.displacementAtrMultiple ?? 1.5,
      maxBlocks: opts?.maxBlocks ?? 80,
      impulseLookback: opts?.impulseLookback ?? 5
    };
  }
  update(candle) {
    const created = [];
    const mitigated = [];
    if (this.candles.length > 0 && candle.timestamp <= this.candles[this.candles.length - 1].timestamp) {
      return { created, mitigated };
    }
    this.candles.push(candle);
    const n = this.candles.length;
    const atrs = atr(this.candles, 14);
    const i = n - 1;
    const a = atrs[i];
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    const displacement = Number.isFinite(a) && a > 0 && (range >= a * this.opts.displacementAtrMultiple || body >= a * this.opts.displacementAtrMultiple * 0.8 && body > 0);
    if (displacement && n >= 2) {
      const impulseIsUp = candle.close > candle.open;
      const originIndex = this.findImpulseOrigin(n - 1, impulseIsUp);
      if (originIndex >= 0) {
        const origin = this.candles[originIndex];
        const block = this.build(
          impulseIsUp ? "BULLISH" : "BEARISH",
          origin.low,
          origin.high,
          originIndex,
          origin.timestamp,
          a
        );
        this.creationIndex.set(block.id, n - 1);
        created.push(block);
      }
    }
    const current = this.candles[n - 1];
    for (const block of this.blocks) {
      if (block.status === "MITIGATED") continue;
      if (n - 1 <= (this.creationIndex.get(block.id) ?? -1)) continue;
      if (current.low <= block.bottom || current.high >= block.top) {
        if (current.high >= block.top && current.close < block.bottom) {
          block.status = "MITIGATED";
          block.mitigatedAt = current.timestamp;
          mitigated.push(block);
        } else if (current.low <= block.bottom && current.close > block.top) {
          block.status = "MITIGATED";
          block.mitigatedAt = current.timestamp;
          mitigated.push(block);
        } else if (current.high >= block.bottom && current.low <= block.top) {
          block.touchCount += 1;
        }
      }
    }
    if (this.blocks.length > this.opts.maxBlocks) {
      this.blocks = this.blocks.slice(-this.opts.maxBlocks);
    }
    return { created, mitigated };
  }
  build(direction, bottom, top, candleIndex, timestamp, atrValue2) {
    const id = hashString(
      `${this.symbol}:${this.timeframe}:OB:${direction}:${bottom.toFixed(8)}:${timestamp}`
    );
    const range = Math.abs(top - bottom);
    const displacement = Number.isFinite(atrValue2) && atrValue2 > 0 ? range / atrValue2 : 1;
    const strength = Math.min(1, 0.35 + displacement * 0.4);
    const block = {
      id,
      symbol: this.symbol,
      exchange: this.exchange,
      timeframe: this.timeframe,
      direction,
      top,
      bottom,
      candleIndex,
      timestamp,
      touchCount: 0,
      status: "FRESH",
      strength
    };
    this.blocks.push(block);
    return block;
  }
  /**
   * Index of the last candle closing against an impulse that ends at
   * `endIndex`, or -1 when the impulse has no such origin in range.
   */
  findImpulseOrigin(endIndex, impulseIsUp) {
    for (let k = 1; k <= this.opts.impulseLookback; k++) {
      const index = endIndex - k;
      if (index < 0) return -1;
      const c = this.candles[index];
      const body = c.close - c.open;
      if (body === 0) continue;
      if (impulseIsUp ? body < 0 : body > 0) return index;
    }
    return -1;
  }
  getBlocks() {
    return this.blocks;
  }
  fresh(direction) {
    return this.blocks.filter((b) => b.direction === direction && b.status === "FRESH");
  }
};

// ../../packages/core/src/engines/supplydemand.ts
var SupplyDemandEngine = class {
  static {
    __name(this, "SupplyDemandEngine");
  }
  symbol;
  exchange;
  timeframe;
  candles = [];
  zones = [];
  opts;
  constructor(symbol, exchange, timeframe, opts) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = {
      displacementAtrMultiple: opts?.displacementAtrMultiple ?? 1.5,
      maxZones: opts?.maxZones ?? 60
    };
  }
  update(candle) {
    const created = [];
    if (this.candles.length > 0 && candle.timestamp <= this.candles[this.candles.length - 1].timestamp) {
      return { created };
    }
    this.candles.push(candle);
    const n = this.candles.length;
    if (n < 4) return { created };
    const a = atrValue(this.candles, 14, n - 1);
    if (!(a > 0)) return { created };
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    const isDisplacement = range >= a * this.opts.displacementAtrMultiple || body >= a * this.opts.displacementAtrMultiple * 0.7 && body > 0;
    const existingCount = this.zones.length;
    if (isDisplacement) {
      const bullish = candle.close > candle.open;
      let baseStart = n - 2;
      let baseLow = Infinity;
      let baseHigh = -Infinity;
      for (let j = n - 2; j >= Math.max(0, n - 6); j--) {
        const base = this.candles[j];
        if (!base) break;
        const baseRange = base.high - base.low;
        if (baseRange > a * 1.2) break;
        baseLow = Math.min(baseLow, base.low);
        baseHigh = Math.max(baseHigh, base.high);
        baseStart = j;
      }
      if (n - 1 - baseStart >= 2 && Number.isFinite(baseLow)) {
        const kind = bullish ? "DEMAND" : "SUPPLY";
        const id = hashString(
          `${this.symbol}:${this.timeframe}:SD:${kind}:${baseLow.toFixed(8)}:${baseHigh.toFixed(8)}:${candle.timestamp}`
        );
        const displacementRatio = Math.min(3, range / a);
        const zone = {
          id,
          symbol: this.symbol,
          exchange: this.exchange,
          timeframe: this.timeframe,
          kind,
          top: baseHigh,
          bottom: baseLow,
          candleIndex: baseStart,
          timestamp: this.candles[baseStart]?.timestamp ?? candle.timestamp,
          touchCount: 0,
          status: "FRESH",
          rank: Math.min(1, 0.4 + displacementRatio * 0.2)
        };
        this.zones.push(zone);
        created.push(zone);
      }
    }
    const current = this.candles[n - 1];
    for (let i = 0; i < existingCount && i < this.zones.length; i++) {
      const zone = this.zones[i];
      if (zone.status === "MITIGATED") continue;
      if (current.low <= zone.bottom && current.close < zone.top) {
        zone.status = "MITIGATED";
        zone.mitigatedAt = current.timestamp;
      } else if (current.high >= zone.bottom && current.low <= zone.top) {
        zone.touchCount += 1;
        zone.rank = Math.max(0.1, zone.rank - 0.1 * zone.touchCount);
      }
    }
    if (this.zones.length > this.opts.maxZones) {
      this.zones = this.zones.slice(-this.opts.maxZones);
    }
    return { created };
  }
  getZones() {
    return this.zones;
  }
  fresh(kind) {
    return this.zones.filter((z) => z.kind === kind && z.status === "FRESH");
  }
};

// ../../packages/core/src/engines/premiumdiscount.ts
function premiumDiscountRatio(price, range) {
  const span = range.high - range.low;
  if (span <= 0) return 0.5;
  return Math.min(1, Math.max(0, (price - range.low) / span));
}
__name(premiumDiscountRatio, "premiumDiscountRatio");
function pdPosition(ratio) {
  if (ratio >= 0.5 + 0.05) return "PREMIUM";
  if (ratio <= 0.5 - 0.05) return "DISCOUNT";
  return "EQUILIBRIUM";
}
__name(pdPosition, "pdPosition");
function describePd(ratio) {
  const p = pdPosition(ratio);
  if (p === "DISCOUNT") return `Discount (${(ratio * 100).toFixed(0)}% of range)`;
  if (p === "PREMIUM") return `Premium (${(ratio * 100).toFixed(0)}% of range)`;
  return `Equilibrium (${(ratio * 100).toFixed(0)}% of range)`;
}
__name(describePd, "describePd");

// ../../packages/core/src/engines/momentum.ts
var MomentumEngine = class {
  static {
    __name(this, "MomentumEngine");
  }
  symbol;
  exchange;
  timeframe;
  candles = [];
  opts;
  constructor(symbol, exchange, timeframe, opts) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.timeframe = timeframe;
    this.opts = { atrPeriod: opts?.atrPeriod ?? 14 };
  }
  update(candle) {
    if (this.candles.length > 0 && candle.timestamp <= this.candles[this.candles.length - 1].timestamp) {
      return this.evaluate();
    }
    this.candles.push(candle);
    return this.evaluate();
  }
  evaluate() {
    const n = this.candles.length;
    if (n < 3) {
      return {
        displacement: 0,
        consecutiveDirection: 0,
        direction: "NEUTRAL",
        impulse: false,
        label: "Insufficient data",
        score: 0
      };
    }
    const a = atrValue(this.candles, this.opts.atrPeriod, n - 1);
    const last = this.candles[n - 1];
    const range = last ? last.high - last.low : 0;
    const displacement = a > 0 ? range / a : 0;
    let consecutiveDirection = 1;
    let direction = "NEUTRAL";
    if (last) {
      direction = last.close > last.open ? "UP" : last.close < last.open ? "DOWN" : "NEUTRAL";
    }
    let runRangeSum = range;
    for (let i = n - 2; i >= 0; i--) {
      const c = this.candles[i];
      if (!c) break;
      const dir = c.close > c.open ? "UP" : c.close < c.open ? "DOWN" : "NEUTRAL";
      if (dir === direction && dir !== "NEUTRAL") {
        consecutiveDirection++;
        runRangeSum += c.high - c.low;
      } else {
        break;
      }
    }
    const avgRunDisplacement = consecutiveDirection > 0 && a > 0 ? runRangeSum / consecutiveDirection / a : 0;
    const impulse = consecutiveDirection >= 3 && avgRunDisplacement >= 1;
    let label;
    if (impulse) label = direction === "UP" ? "Bullish impulse" : direction === "DOWN" ? "Bearish impulse" : "Impulse";
    else if (displacement >= 1.5) label = direction === "UP" ? "Strong upward displacement" : direction === "DOWN" ? "Strong downward displacement" : "Displacement";
    else if (consecutiveDirection >= 3) label = "Corrective / trending";
    else label = "Low momentum";
    const score = Math.min(
      1,
      Math.max(
        0,
        displacement / 3 * 0.6 + Math.min(1, consecutiveDirection / 5) * 0.4
      )
    );
    return { displacement, consecutiveDirection, direction, impulse, label, score };
  }
};

// ../../packages/core/src/strategy/topdown.ts
function topDownAnalysis(htf, mtf, ltf) {
  let bias;
  if (htf.trend === "BULLISH") bias = "BULLISH";
  else if (htf.trend === "BEARISH") bias = "BEARISH";
  else if (htf.trend === "RANGING") bias = "NEUTRAL";
  else bias = "UNCLEAR";
  let conflict = null;
  if (bias === "BULLISH") {
    if (mtf.trend === "BEARISH" && mtf.strength === "STRONG") {
      conflict = "Mid-timeframe structure is strongly bearish against the bullish higher timeframe.";
    } else if (ltf.trend === "BEARISH" && ltf.strength === "STRONG") {
      conflict = "Lower timeframe structure is strongly bearish. Waiting for a lower-timeframe bullish shift.";
    }
  } else if (bias === "BEARISH") {
    if (mtf.trend === "BULLISH" && mtf.strength === "STRONG") {
      conflict = "Mid-timeframe structure is strongly bullish against the bearish higher timeframe.";
    } else if (ltf.trend === "BULLISH" && ltf.strength === "STRONG") {
      conflict = "Lower timeframe structure is strongly bullish. Waiting for a lower-timeframe bearish shift.";
    }
  }
  let alignment = 0;
  if (bias === "BULLISH" || bias === "BEARISH") {
    const dir = bias === "BULLISH" ? "BULLISH" : "BEARISH";
    if (htf.trend === dir) alignment++;
    if (mtf.trend === dir) alignment++;
    if (ltf.trend === dir) alignment++;
  }
  return {
    bias,
    htf,
    mtf,
    ltf,
    conflict,
    alignment
  };
}
__name(topDownAnalysis, "topDownAnalysis");
function snapshotToBias(snapshot, timeframe) {
  return {
    timeframe,
    trend: snapshot.trend,
    strength: snapshot.strength
  };
}
__name(snapshotToBias, "snapshotToBias");

// ../../packages/core/src/strategy/scoring.ts
function scoreSetup(input) {
  const components = [
    {
      name: "Multi-timeframe alignment",
      weight: 0.18,
      value: input.alignment / 3,
      detail: `${input.alignment}/3 timeframes aligned`
    },
    {
      name: "Higher timeframe strength",
      weight: 0.1,
      value: input.ht === "STRONG" ? 1 : 0.5,
      detail: `HTF structure ${input.ht}`
    },
    {
      name: "POI quality",
      weight: 0.15,
      value: Math.min(1, input.poiStrength),
      detail: input.poiStatus === "FRESH" ? "Fresh POI" : "Mitigated POI"
    },
    {
      name: "Entry model confirmation",
      weight: 0.12,
      value: input.chochConfirmed ? 1 : 0.6,
      detail: input.chochConfirmed ? "CHoCH confirmed" : "Pending confirmation"
    },
    {
      name: "Liquidity context",
      weight: 0.12,
      value: Math.min(1, input.sweepQuality + input.targetLiquidity * 0.4),
      detail: `Sweep ${(input.sweepQuality * 100).toFixed(0)}% / target liquidity present`
    },
    {
      name: "Order block / FVG",
      weight: 0.1,
      value: (input.obFresh ? 0.5 : 0) + (input.fvgFresh ? 0.5 : 0),
      detail: `OB ${input.obFresh ? "fresh" : "absent/mitigated"}, FVG ${input.fvgFresh ? "fresh" : "absent/mitigated"}`
    },
    {
      name: "Premium / discount",
      weight: 0.08,
      value: input.discountDepth,
      detail: `Discount depth ${(input.discountDepth * 100).toFixed(0)}%`
    },
    {
      name: "Momentum",
      weight: 0.05,
      value: input.momentumScore,
      detail: `Momentum ${(input.momentumScore * 100).toFixed(0)}%`
    },
    {
      name: "Reward quality",
      weight: 0.1,
      value: Math.min(1, input.rrDepth),
      detail: `RR depth ${input.rrDepth.toFixed(2)}`
    }
  ];
  let score = 0;
  for (const c of components) {
    score += c.weight * c.value * 100;
  }
  return { score: Math.round(Math.min(100, Math.max(0, score))), components };
}
__name(scoreSetup, "scoreSetup");

// ../../packages/core/src/strategy/analysis-engine.ts
var AnalysisEngine = class {
  static {
    __name(this, "AnalysisEngine");
  }
  symbol;
  exchange;
  cfg;
  engines = {};
  candles = {};
  events = [];
  lastSetupKeys = /* @__PURE__ */ new Set();
  lastStatus = "SCANNING";
  lastNoTradeReason;
  setupCounter = 0;
  constructor(symbol, exchange, cfg) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.cfg = cfg;
    const tfs = [cfg.timeframes.htf, cfg.timeframes.mtf, cfg.timeframes.ltf];
    for (const tf of new Set(tfs)) {
      this.engines[tf] = {
        structure: new MarketStructureEngine(symbol, exchange, tf, {
          strength: cfg.swingStrength,
          lookback: cfg.structureLookback
        }),
        liquidity: new LiquidityEngine(symbol, exchange, tf, {
          strength: cfg.swingStrength,
          toleranceAtr: cfg.equalLevelToleranceAtr
        }),
        fvg: new FvgEngine(symbol, exchange, tf),
        ob: new OrderBlockEngine(symbol, exchange, tf, {
          displacementAtrMultiple: cfg.displacementAtrMultiple
        }),
        sd: new SupplyDemandEngine(symbol, exchange, tf, {
          displacementAtrMultiple: cfg.displacementAtrMultiple
        }),
        momentum: new MomentumEngine(symbol, exchange, tf, { atrPeriod: cfg.atrPeriod })
      };
      this.candles[tf] = [];
    }
  }
  /**
   * Apply configuration changes that are safe to make at runtime. Structural
   * fields that define the engine graph (symbol, exchange, timeframes, swing
   * detection) must not change after construction and are rejected.
   */
  updateConfig(cfg) {
    const runFor = /* @__PURE__ */ __name((key) => cfg[key] !== this.cfg[key], "runFor");
    if (runFor("symbol") || runFor("exchange")) {
      throw new Error("symbol and exchange cannot be changed at runtime.");
    }
    if (cfg.timeframes.htf !== this.cfg.timeframes.htf || cfg.timeframes.mtf !== this.cfg.timeframes.mtf || cfg.timeframes.ltf !== this.cfg.timeframes.ltf) {
      throw new Error("timeframes cannot be changed at runtime - restart required.");
    }
    if (runFor("swingStrength") || runFor("structureLookback")) {
      throw new Error("swingStrength and structureLookback cannot be changed at runtime - restart required.");
    }
    this.cfg = cfg;
  }
  /** Feed a CLOSED candle. Only the given timeframe is updated. */
  onCandleClosed(candle) {
    const tf = candle.timeframe;
    const eng = this.engines[tf];
    if (!eng) return;
    const buf = this.candles[tf] ?? (this.candles[tf] = []);
    if (buf.length && buf[buf.length - 1].timestamp >= candle.timestamp) return;
    buf.push(candle);
    if (buf.length > 2e3) buf.splice(0, buf.length - 2e3);
    const structureResult = eng.structure.update(candle);
    const structureEvents = eng.structure.evaluate();
    for (const ev of structureEvents.bos) {
      this.events.push({
        type: "BOS",
        timestamp: ev.timestamp,
        detail: `${ev.direction} break of structure confirmed at ${ev.brokenLevel.toFixed(2)} (${tf}).`
      });
    }
    for (const ev of structureEvents.choch) {
      this.events.push({
        type: "CHOCH",
        timestamp: ev.timestamp,
        detail: `${ev.direction} CHoCH confirmed at ${ev.brokenLevel.toFixed(2)} (${tf}).`
      });
    }
    const liqResult = eng.liquidity.update(candle);
    for (const sw of liqResult.sweeps) {
      this.events.push({
        type: "SWEEP",
        timestamp: sw.timestamp,
        detail: `Sell-side liquidity swept at ${sw.level.toFixed(2)} (${tf})${sw.rejected ? " with rejection" : ""}.`
      });
    }
    eng.fvg.update(candle);
    eng.ob.update(candle);
    eng.sd.update(candle);
    eng.momentum.update(candle);
    this.trimEvents();
  }
  trimEvents() {
    if (this.events.length > 500) this.events = this.events.slice(-500);
  }
  /** Run a full analysis cycle over the current (closed-candle) state. */
  analyze() {
    const htf = this.cfg.timeframes.htf;
    const mtf = this.cfg.timeframes.mtf;
    const ltf = this.cfg.timeframes.ltf;
    const htfSnap = this.engines[htf]?.structure.snapshot();
    const mtfSnap = this.engines[mtf]?.structure.snapshot();
    const ltfSnap = this.engines[ltf]?.structure.snapshot();
    const td = htfSnap && mtfSnap && ltfSnap ? topDownAnalysis(
      snapshotToBias(htfSnap, htf),
      snapshotToBias(mtfSnap, mtf),
      snapshotToBias(ltfSnap, ltf)
    ) : null;
    const bias = td?.bias ?? "UNCLEAR";
    const snapshots = this.buildSnapshots();
    const setups = this.buildSetups(td, snapshots);
    for (const s of setups) {
      if (!this.lastSetupKeys.has(s.id)) {
        this.lastSetupKeys.add(s.id);
        this.events.push({
          type: "SETUP",
          timestamp: s.createdAt,
          detail: `${s.symbol} ${s.direction} ${s.entryModel} setup ${s.status === "REJECTED" ? `rejected \u2014 ${s.rejectionReasons[0] ?? "no reason"}` : `scored ${s.score}/100`}.`
        });
      }
    }
    this.trimEvents();
    this.lastStatus = this.computeStatus(setups, td, snapshots);
    const topDown = td ? {
      htf: { timeframe: htf, trend: td.htf.trend, strength: td.htf.strength },
      mtf: { timeframe: mtf, trend: td.mtf.trend, strength: td.mtf.strength },
      ltf: { timeframe: ltf, trend: td.ltf.trend },
      conflict: td.conflict ?? void 0
    } : { htf: { timeframe: htf, trend: "NEUTRAL", strength: "WEAK" }, mtf: { timeframe: mtf, trend: "NEUTRAL", strength: "WEAK" }, ltf: { timeframe: ltf, trend: "NEUTRAL" } };
    return {
      symbol: this.symbol,
      exchange: this.exchange,
      bias,
      topDown,
      snapshots,
      setups,
      events: this.events.slice(-80),
      status: this.lastStatus,
      noTradeReason: setups.length === 0 ? this.lastNoTradeReason : void 0,
      updatedAt: this.now()
    };
  }
  computeStatus(setups, td, snapshots) {
    if (this.isSafe) return "SAFE_MODE";
    const valid = setups.filter((s) => s.status === "VALID");
    if (valid.length > 0) return "READY";
    const reject = setups.filter((s) => s.status === "REJECTED");
    if (reject.length > 0) return "REJECTED";
    this.lastNoTradeReason = this.explainNoSetup(td, snapshots);
    if (!td) return "WAITING_FOR_DATA";
    if (td.bias === "UNCLEAR") return "NO_HTF_BIAS";
    return "WAITING_FOR_POI";
  }
  /** Human-readable account of why the pipeline produced no setup. */
  explainNoSetup(td, snapshots) {
    const htf = this.cfg.timeframes.htf;
    const ltf = this.cfg.timeframes.ltf;
    const ltfCount = this.candles[ltf]?.length ?? 0;
    if (!td) {
      return `Not enough candle history yet to establish structure on ${htf}, ${this.cfg.timeframes.mtf} and ${ltf}.`;
    }
    if (ltfCount < 30) {
      return `Only ${ltfCount} ${ltf} candles are loaded; at least 30 are required before a setup is considered.`;
    }
    if (td.bias === "UNCLEAR") {
      return `No directional bias: ${htf} structure is ${td.htf.trend.toLowerCase()}, so neither a long nor a short thesis is valid yet. The engine trades with the higher timeframe, not against an undecided one.`;
    }
    if (td.conflict) return td.conflict;
    const poiCounts = [this.cfg.timeframes.mtf, ltf].map((tf) => snapshots[tf]?.orderBlocks.filter((b) => b.status === "FRESH").length ?? 0).reduce((a, b) => a + b, 0);
    if (poiCounts === 0) {
      return `${htf} bias is ${td.bias.toLowerCase()} but no unmitigated point of interest is in range, so there is nothing to trade into.`;
    }
    return `${htf} bias is ${td.bias.toLowerCase()} and points of interest exist, but price has not reached one within the configured entry tolerance.`;
  }
  get isSafe() {
    return false;
  }
  buildSnapshots() {
    const out = {};
    for (const [tf, eng] of Object.entries(this.engines)) {
      const structure = eng.structure.evaluate();
      out[tf] = {
        timeframe: tf,
        structure: eng.structure.snapshot(),
        bos: eng.structure.lastBosEvents,
        choch: eng.structure.lastChochEvents,
        sweeps: eng.liquidity.getZones().filter((z) => z.status === "SWEPT").slice(-20).map((z) => ({
          type: "LIQUIDITY_SWEEP",
          symbol: this.symbol,
          exchange: this.exchange,
          timeframe: tf,
          direction: z.type === "BSL" ? "SHORT" : "LONG",
          zoneId: z.id,
          level: z.level,
          extremePrice: z.level,
          closePrice: z.level,
          candleIndex: -1,
          timestamp: z.sweptAt ?? z.createdAt,
          rejected: false,
          structureShiftAfter: false
        })),
        liquidityZones: eng.liquidity.getZones().slice(-40),
        fvgs: eng.fvg.getZones().slice(-30),
        orderBlocks: eng.ob.getBlocks().slice(-30),
        supplyDemand: eng.sd.getZones().slice(-30),
        momentum: eng.momentum.evaluate().label,
        candles: this.candles[tf]?.slice(-250) ?? []
      };
    }
    return out;
  }
  now() {
    let max = 0;
    for (const buf of Object.values(this.candles)) {
      const last = buf?.[buf.length - 1];
      if (last && last.timestamp > max) max = last.timestamp;
    }
    return max;
  }
  /** Closed candles held for the given timeframe (used for last price etc). */
  candlesFor(tf) {
    return this.candles[tf] ?? [];
  }
  // ------------------------------------------------------------------
  // Setup construction
  // ------------------------------------------------------------------
  buildSetups(td, snapshots) {
    const ltf = this.cfg.timeframes.ltf;
    const mtf = this.cfg.timeframes.mtf;
    const htf = this.cfg.timeframes.htf;
    const lastPrice = this.lastPriceOf(ltf);
    if (td === null || !lastPrice) return [];
    if ((this.candles[ltf]?.length ?? 0) < 30) return [];
    const setups = [];
    const longPoi = this.findPoi(lastPrice, "LONG", [mtf, ltf], snapshots);
    const shortPoi = this.findPoi(lastPrice, "SHORT", [mtf, ltf], snapshots);
    const models = [];
    if (this.cfg.entryModels.aggressive) models.push("AGGRESSIVE");
    if (this.cfg.entryModels.confirmation) models.push("CONFIRMATION");
    if (this.cfg.entryModels.sweep) models.push("SWEEP");
    if (this.cfg.entryModels.counterTrend) models.push("COUNTER_TREND");
    for (const model of models) {
      let direction = null;
      if (model === "COUNTER_TREND") {
        if (td.bias === "BEARISH") direction = "LONG";
        else if (td.bias === "BULLISH") direction = "SHORT";
        else direction = longPoi ? "LONG" : shortPoi ? "SHORT" : null;
      } else if (td.bias === "BEARISH") {
        direction = "SHORT";
      } else if (td.bias === "BULLISH") {
        direction = "LONG";
      } else if (td.bias === "NEUTRAL") {
        direction = longPoi && shortPoi ? null : longPoi ? "LONG" : shortPoi ? "SHORT" : null;
      }
      if (!direction) continue;
      const poi = direction === "LONG" ? longPoi : shortPoi;
      const setup = this.buildSetup(
        td,
        snapshots,
        direction,
        model,
        poi,
        lastPrice,
        ltf,
        mtf,
        htf
      );
      if (setup) {
        const quality = this.evaluateQuality(setup, td, snapshots);
        setup.qualityFactors = quality.factors;
        setup.hardRules = quality.hardRules;
        setup.score = quality.score;
        setup.status = this.resolveSetupStatus(setup, quality);
        if (setup.status === "REJECTED") {
          setup.rejectionReasons = quality.rejections;
        }
        setups.push(setup);
      }
    }
    return setups;
  }
  lastPriceOf(tf) {
    const buf = this.candles[tf];
    const last = buf?.[buf.length - 1];
    return last ? last.close : void 0;
  }
  findPoi(price, direction, sources, snapshots) {
    const tol = this.cfg.entryTolerancePct / 100;
    const candidates = [];
    const buf = this.candles[this.cfg.timeframes.ltf];
    const lastIndex = buf ? buf.length - 1 : 0;
    const a = buf ? atr(buf, 14)[lastIndex] : 0;
    for (const tf of sources) {
      const snap = snapshots[tf];
      if (!snap) continue;
      if (direction === "LONG") {
        for (const z of snap.orderBlocks.filter((o) => o.direction === "BULLISH" && o.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "ORDER_BLOCK",
              id: z.id,
              direction: "BULLISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: z.strength,
              label: `${tf} bullish order block`
            },
            source: tf
          });
        }
        for (const z of snap.fvgs.filter((f) => f.direction === "BULLISH" && f.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "FVG",
              id: z.id,
              direction: "BULLISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: 0.6,
              label: `${tf} bullish fair value gap`
            },
            source: tf
          });
        }
        for (const z of snap.supplyDemand.filter((s) => s.kind === "DEMAND" && s.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "DEMAND",
              id: z.id,
              direction: "BULLISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: z.rank,
              label: `${tf} demand zone`
            },
            source: tf
          });
        }
      } else {
        for (const z of snap.orderBlocks.filter((o) => o.direction === "BEARISH" && o.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "ORDER_BLOCK",
              id: z.id,
              direction: "BEARISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: z.strength,
              label: `${tf} bearish order block`
            },
            source: tf
          });
        }
        for (const z of snap.fvgs.filter((f) => f.direction === "BEARISH" && f.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "FVG",
              id: z.id,
              direction: "BEARISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: 0.6,
              label: `${tf} bearish fair value gap`
            },
            source: tf
          });
        }
        for (const z of snap.supplyDemand.filter((s) => s.kind === "SUPPLY" && s.status === "FRESH")) {
          candidates.push({
            zone: {
              kind: "SUPPLY",
              id: z.id,
              direction: "BEARISH",
              top: z.top,
              bottom: z.bottom,
              timeframe: tf,
              createdAt: z.timestamp,
              status: z.status,
              strength: z.rank,
              label: `${tf} supply zone`
            },
            source: tf
          });
        }
      }
    }
    const tolPrice = Math.max(price * tol, a * 0.5, price * 1e-4);
    const qualifying = candidates.filter((c) => {
      if (direction === "LONG") {
        return c.zone.bottom <= price + tolPrice && c.zone.top >= price - tolPrice;
      }
      return c.zone.bottom <= price + tolPrice && c.zone.top >= price - tolPrice;
    });
    if (qualifying.length === 0) return void 0;
    qualifying.sort((x, y) => {
      const dx = Math.abs(price - (x.zone.top + x.zone.bottom) / 2);
      const dy = Math.abs(price - (y.zone.top + y.zone.bottom) / 2);
      return dx - dy;
    });
    return qualifying[0];
  }
  buildSetup(td, snapshots, direction, model, poi, price, ltf, mtf, htf) {
    if (!poi) return void 0;
    const zone = poi.zone;
    const entry = direction === "LONG" ? Math.max(zone.top, price * (1 - this.cfg.entryTolerancePct / 100)) : Math.min(zone.bottom, price * (1 + this.cfg.entryTolerancePct / 100));
    const ltfSnap = snapshots[ltf];
    const mtfSnap = snapshots[mtf];
    const htfSnap = snapshots[htf];
    if (!ltfSnap || !mtfSnap || !htfSnap) return void 0;
    const a = this.atrAt(ltf);
    const buffer = Math.max(a * 0.1, entry * 8e-4);
    const structuralLow = ltfSnap.structure.lastSwingLow?.price;
    const structuralHigh = ltfSnap.structure.lastSwingHigh?.price;
    let stopLoss;
    let stopLossReason;
    if (direction === "LONG") {
      const belowZone = zone.bottom - buffer;
      const belowSwing = structuralLow !== void 0 ? Math.min(structuralLow, zone.bottom) - buffer : belowZone;
      stopLoss = Math.min(belowZone, belowSwing);
      stopLossReason = `SL placed below the ${poi.source} ${zone.label} and the structural swing low because invalidation occurs if price closes through this level.`;
    } else {
      const aboveZone = zone.top + buffer;
      const aboveSwing = structuralHigh !== void 0 ? Math.max(structuralHigh, zone.top) + buffer : aboveZone;
      stopLoss = Math.max(aboveZone, aboveSwing);
      stopLossReason = `SL placed above the ${poi.source} ${zone.label} and the structural swing high because invalidation occurs if price closes through this level.`;
    }
    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0) return void 0;
    const targets = this.computeTargets(direction, entry, risk, snapshots);
    const takeProfits = targets.targets;
    const takeProfitReasons = targets.reasons;
    const rr = takeProfits.map((t) => Math.abs(t - entry) / risk);
    if (takeProfits.length === 0) return void 0;
    const htfBias = td.bias;
    const counterTrend = direction === "LONG" ? htfBias === "BEARISH" : htfBias === "BULLISH";
    const id = hashString(
      `${this.symbol}:${direction}:${model}:${zone.id}:${entry.toFixed(4)}:${this.setupCounter++}:${this.now()}`
    );
    const components = this.collectComponents(direction, snapshots, ltf, entry, risk, zone);
    const setup = {
      id,
      symbol: this.symbol,
      exchange: this.exchange,
      direction,
      timeframe: ltf,
      entryModel: model,
      htfTrend: htfBias === "UNCLEAR" ? "NEUTRAL" : htfBias,
      timeframeAnalysis: {
        htf: { timeframe: htf, trend: td.htf.trend, strength: td.htf.strength },
        mtf: { timeframe: mtf, trend: td.mtf.trend, strength: td.mtf.strength },
        ltf: { timeframe: ltf, trend: td.ltf.trend },
        conflict: td.conflict ?? void 0
      },
      entry,
      stopLoss,
      stopLossReason,
      takeProfits,
      takeProfitReasons,
      rr,
      riskPct: 0,
      score: 0,
      qualityFactors: [],
      hardRules: [],
      factors: [],
      reasons: [],
      rejectionReasons: [],
      status: "VALIDATING",
      components,
      counterTrend,
      strategyVersion: this.cfg.version,
      createdAt: this.now()
    };
    return setup;
  }
  collectComponents(direction, snapshots, ltf, entry, risk, zone) {
    const ltfSnap = snapshots[ltf];
    const components = {
      poi: {
        kind: zone.kind,
        id: zone.id,
        top: zone.top,
        bottom: zone.bottom,
        strength: zone.strength,
        status: zone.status
      }
    };
    if (ltfSnap) {
      const relevantSweeps = direction === "LONG" ? ltfSnap.sweeps.filter((s) => s.direction === "LONG").slice(-1)[0] : ltfSnap.sweeps.filter((s) => s.direction === "SHORT").slice(-1)[0];
      if (relevantSweeps) components.sweepEvent = relevantSweeps;
      const choch = ltfSnap.choch.at(-1);
      if (choch) components.chochEvent = choch;
      const ob = ltfSnap.orderBlocks.filter((o) => o.direction === (direction === "LONG" ? "BULLISH" : "BEARISH") && o.status === "FRESH").at(-1);
      if (ob) components.orderBlockId = ob.id;
      const fvg = ltfSnap.fvgs.filter((f) => f.direction === (direction === "LONG" ? "BULLISH" : "BEARISH") && f.status === "FRESH").at(-1);
      if (fvg) components.fvgId = fvg.id;
      const targets = direction === "LONG" ? ltfSnap.liquidityZones.filter((z) => z.type === "BSL" && z.level > entry).sort((a, b) => a.level - b.level)[0] : ltfSnap.liquidityZones.filter((z) => z.type === "SSL" && z.level < entry).sort((a, b) => b.level - a.level)[0];
      if (targets) {
        components.targetLiquidity = { type: targets.type, level: targets.level };
      }
      if (this.cfg.premiumDiscountEnabled) {
        const levels = [
          ltfSnap.structure.lastSwingHigh?.price,
          ltfSnap.structure.lastSwingLow?.price
        ].filter((p) => p !== void 0);
        if (levels.length === 2) {
          const ratio = premiumDiscountRatio(entry, { high: Math.max(...levels), low: Math.min(...levels), asOf: 0 });
          components.premiumDiscount = {
            position: pdPosition(ratio),
            ratio
          };
        }
      }
      if (this.cfg.inducementEnabled) {
        const inducer = direction === "LONG" ? ltfSnap.liquidityZones.filter((z) => z.type === "SSL" && z.status === "ACTIVE" && z.level < entry).sort((a, b) => b.level - a.level)[0] : ltfSnap.liquidityZones.filter((z) => z.type === "BSL" && z.status === "ACTIVE" && z.level > entry).sort((a, b) => a.level - b.level)[0];
        if (inducer) {
          components.inducement = {
            detected: true,
            detail: `${direction === "LONG" ? "Sell" : "Buy"}-side liquidity at ${inducer.level.toFixed(2)} may induce premature entries before the intended POI.`
          };
        }
      }
    }
    return components;
  }
  computeTargets(direction, entry, risk, snapshots) {
    const liqType = direction === "LONG" ? "BSL" : "SSL";
    const levels = [];
    for (const tf of [this.cfg.timeframes.ltf, this.cfg.timeframes.mtf, this.cfg.timeframes.htf]) {
      const snap = snapshots[tf];
      if (!snap) continue;
      for (const z of snap.liquidityZones) {
        if (z.type !== liqType) continue;
        if (direction === "LONG" && z.level > entry + risk) levels.push(z.level);
        if (direction === "SHORT" && z.level < entry - risk) levels.push(z.level);
      }
    }
    levels.sort((a, b) => direction === "LONG" ? a - b : b - a);
    const unique = [...new Set(levels.map((l) => Math.round(l * 100) / 100))];
    const swingTargets = [];
    for (const tf of [this.cfg.timeframes.ltf, this.cfg.timeframes.mtf]) {
      const snap = snapshots[tf];
      if (!snap) continue;
      if (direction === "LONG" && snap.structure.lastSwingHigh) {
        swingTargets.push(snap.structure.lastSwingHigh.price);
      }
      if (direction === "SHORT" && snap.structure.lastSwingLow) {
        swingTargets.push(snap.structure.lastSwingLow.price);
      }
    }
    const minRr = this.cfg.minRr;
    const targets = [];
    const reasons = [];
    const liquidityTargets = unique.filter((l) => {
      if (direction === "LONG") return l > entry;
      return l < entry;
    });
    if (liquidityTargets.length >= 1) {
      targets.push(liquidityTargets[0]);
      reasons.push("TP1: nearest opposing buy-side liquidity.");
    }
    if (liquidityTargets.length >= 2) {
      targets.push(liquidityTargets[1]);
      reasons.push("TP2: next opposing liquidity pool.");
    } else if (swingTargets.length > 0) {
      const next = direction === "LONG" ? swingTargets.filter((s) => s > (targets[targets.length - 1] ?? entry)).sort((a, b) => a - b)[0] : swingTargets.filter((s) => s < (targets[targets.length - 1] ?? entry)).sort((a, b) => b - a)[0];
      if (next !== void 0) {
        targets.push(next);
        reasons.push("TP2: external structural swing.");
      }
    }
    const lastTarget = targets[targets.length - 1];
    const rrToLast = lastTarget ? Math.abs(lastTarget - entry) / risk : 0;
    const finalRr = Math.max(minRr, rrToLast + 1);
    const finalTarget = direction === "LONG" ? entry + finalRr * risk : entry - finalRr * risk;
    if (finalTarget !== lastTarget && finalTarget !== targets[targets.length - 2]) {
      targets.push(finalTarget);
      reasons.push(`TP3: projected reward of 1:${finalRr.toFixed(1)}.`);
    }
    return { targets, reasons };
  }
  atrAt(tf) {
    const buf = this.candles[tf];
    if (!buf || buf.length < 16) return 0;
    const values = atr(buf, 14);
    const last = values[values.length - 1];
    return Number.isFinite(last) ? last : 0;
  }
  // ------------------------------------------------------------------
  // Quality / hard-rule evaluation
  // ------------------------------------------------------------------
  evaluateQuality(setup, td, snapshots) {
    const ltfSnap = snapshots[this.cfg.timeframes.ltf];
    const mtfSnap = snapshots[this.cfg.timeframes.mtf];
    const rejections = [];
    const hardRules = [];
    const factors = [];
    const long = setup.direction === "LONG";
    const htfAligned = long && (td.bias === "BULLISH" || td.bias === "NEUTRAL") || !long && (td.bias === "BEARISH" || td.bias === "NEUTRAL");
    hardRules.push({
      name: "HTF bias",
      status: htfAligned ? "PASS" : "FAIL",
      detail: htfAligned ? `${long ? "Bullish" : "Bearish"} higher-timeframe bias.` : `Higher-timeframe bias is ${td.bias === "NEUTRAL" ? "neutral" : "opposing"}.`
    });
    if (!htfAligned && !setup.counterTrend) {
      rejections.push(`Higher-timeframe bias is ${td.bias === "NEUTRAL" ? "neutral/unclear" : "opposing"}.`);
    }
    hardRules.push({
      name: "POI",
      status: "PASS",
      detail: `Price is at a valid ${setup.components.poi?.kind ?? "POI"}.`
    });
    const multiplier = setup.counterTrend ? this.cfg.counterTrendMinRrMultiplier : 1;
    const minRr = this.cfg.minRr * multiplier;
    const tp1MinRr = this.cfg.tp1MinRr * multiplier;
    const rr0 = setup.rr[0] ?? 0;
    const finalRr = setup.rr.length ? Math.max(...setup.rr) : 0;
    const rrOk = finalRr >= minRr;
    hardRules.push({
      name: "Reward-to-risk",
      status: rrOk ? "PASS" : "FAIL",
      detail: rrOk ? `Final target is 1:${finalRr.toFixed(1)}, meeting the 1:${minRr} minimum.` : `Final target is only 1:${finalRr.toFixed(1)}, below the 1:${minRr} minimum.`
    });
    if (!rrOk) {
      rejections.push(`Final target RR = 1:${finalRr.toFixed(1)} is below the required 1:${minRr}.`);
    }
    const tp1Ok = rr0 >= tp1MinRr;
    hardRules.push({
      name: "First target distance",
      status: tp1Ok ? "PASS" : "FAIL",
      detail: tp1Ok ? `TP1 sits at 1:${rr0.toFixed(1)}, at or beyond the 1:${tp1MinRr} minimum.` : `TP1 sits at only 1:${rr0.toFixed(1)}, inside the 1:${tp1MinRr} minimum for a first target.`
    });
    if (!tp1Ok) {
      rejections.push(`TP1 RR = 1:${rr0.toFixed(1)} is below the required 1:${tp1MinRr} for a first target.`);
    }
    let modelPass = false;
    let modelDetail = "";
    if (ltfSnap && mtfSnap) {
      if (setup.entryModel === "AGGRESSIVE") {
        modelPass = td.alignment >= 2 && td.conflict === null && rrOk;
        modelDetail = modelPass ? "Aggressive entry: aligned timeframes and valid POI without lower-timeframe confirmation." : td.conflict !== null ? "Aggressive entry requires aligned timeframes; a lower-timeframe conflict exists." : "Aggressive entry requires multi-timeframe alignment.";
      } else if (setup.entryModel === "CONFIRMATION") {
        const chochOk = ltfSnap.choch.some(
          (c) => long ? c.direction === "BULLISH" : c.direction === "BEARISH"
        );
        const ltfTrendOk = long ? ltfSnap.structure.trend === "BULLISH" : ltfSnap.structure.trend === "BEARISH";
        modelPass = chochOk || ltfTrendOk && rrOk;
        modelDetail = chochOk ? "Lower-timeframe CHoCH confirmed." : ltfTrendOk ? "Lower-timeframe trend supports the setup." : "Waiting for lower-timeframe CHoCH confirmation.";
        if (!chochOk) {
          rejections.push("Lower-timeframe CHoCH has not been confirmed.");
        }
      } else if (setup.entryModel === "SWEEP") {
        const sweep = ltfSnap.sweeps.at(-1);
        const sweepOk = !!sweep && sweep.rejected;
        const chochOk = ltfSnap.choch.some(
          (c) => long ? c.direction === "BULLISH" : c.direction === "BEARISH"
        );
        modelPass = sweepOk && chochOk && rrOk;
        if (!sweepOk) rejections.push("No recent confirmed liquidity sweep with rejection.");
        if (!chochOk) rejections.push("No CHoCH after the sweep.");
        modelDetail = modelPass ? "Liquidity swept with rejection and structure shift confirmed." : "Sweep entry requires a liquidity sweep with rejection followed by a structure shift.";
      } else {
        const chochOk = ltfSnap.choch.some(
          (c) => long ? c.direction === "BULLISH" : c.direction === "BEARISH"
        );
        modelPass = chochOk && td.conflict !== null && rrOk;
        modelDetail = modelPass ? "Counter-trend setup: lower-timeframe shift against the higher timeframe with stronger RR requirement." : "Counter-trend setups require a confirmed shift against the higher timeframe.";
      }
    }
    hardRules.push({
      name: "Entry model",
      status: modelPass ? "PASS" : "FAIL",
      detail: modelPass ? modelDetail : modelDetail || "Entry model conditions not met."
    });
    if (!modelPass) {
      rejections.push(modelDetail || "Entry model conditions not met.");
    }
    const ltfConfirmed = !!ltfSnap && (ltfSnap.choch.some((c) => long ? c.direction === "BULLISH" : c.direction === "BEARISH") || (long ? ltfSnap.structure.trend === "BULLISH" : ltfSnap.structure.trend === "BEARISH"));
    factors.push({
      name: "LTF confirmation",
      status: ltfConfirmed ? "PASS" : "NEUTRAL",
      detail: ltfConfirmed ? "Lower timeframe has confirmed the move." : "Lower timeframe has not confirmed."
    });
    if (td.conflict === null) {
      factors.push({ name: "Timeframe alignment", status: "PASS", detail: "No timeframe conflict." });
    } else {
      factors.push({ name: "Timeframe alignment", status: "NEUTRAL", detail: td.conflict });
    }
    const ob = setup.components.orderBlockId ? (ltfSnap?.orderBlocks ?? []).find((o) => o.id === setup.components.orderBlockId) : void 0;
    factors.push({
      name: "Order block",
      status: ob ? "PASS" : "NEUTRAL",
      detail: ob ? `Fresh order block (strength ${ob.strength.toFixed(2)}).` : "No fresh order block in the entry zone."
    });
    const fvg = setup.components.fvgId ? (ltfSnap?.fvgs ?? []).find((f) => f.id === setup.components.fvgId) : void 0;
    factors.push({
      name: "Fair value gap",
      status: fvg ? "PASS" : "NEUTRAL",
      detail: fvg ? "Fresh fair value gap in the entry zone." : "No fresh fair value gap."
    });
    if (setup.components.premiumDiscount) {
      const good = long && setup.components.premiumDiscount.position !== "PREMIUM" || !long && setup.components.premiumDiscount.position !== "DISCOUNT";
      factors.push({
        name: "Premium / discount",
        status: good ? "PASS" : "NEUTRAL",
        detail: describePd(setup.components.premiumDiscount.ratio)
      });
    }
    if (setup.components.sweepEvent) {
      factors.push({
        name: "Liquidity sweep",
        status: setup.components.sweepEvent.rejected ? "PASS" : "NEUTRAL",
        detail: setup.components.sweepEvent.rejected ? `${setup.components.sweepEvent.direction === "LONG" ? "Sell" : "Buy"}-side liquidity swept with rejection.` : "Liquidity swept without a clean rejection."
      });
    }
    if (setup.components.targetLiquidity) {
      factors.push({
        name: "Target liquidity",
        status: "PASS",
        detail: `Target liquidity at ${setup.components.targetLiquidity.level.toFixed(2)}.`
      });
    }
    if (setup.components.inducement?.detected) {
      factors.push({
        name: "Inducement",
        status: "NEUTRAL",
        detail: setup.components.inducement.detail
      });
    }
    const hardOk = hardRules.every((h) => h.status === "PASS");
    const quality = scoreSetup({
      alignment: td.alignment,
      ht: td.htf.strength,
      poiStrength: setup.components.poi?.strength ?? 0.5,
      poiStatus: setup.components.poi?.status ?? "FRESH",
      fvgFresh: !!fvg,
      obFresh: !!ob,
      sweepQuality: setup.components.sweepEvent ? setup.components.sweepEvent.rejected ? 1 : 0.5 : 0,
      discountDepth: setup.components.premiumDiscount?.position === "DISCOUNT" ? 1 - setup.components.premiumDiscount.ratio : setup.components.premiumDiscount?.position === "PREMIUM" ? setup.components.premiumDiscount.ratio : 0.5,
      momentumScore: ltfSnap ? setup.components.momentum?.score ?? 0.5 : 0.5,
      rrDepth: Math.min(1, finalRr / (minRr * 1.5)),
      targetLiquidity: setup.components.targetLiquidity ? 1 : 0,
      chochConfirmed: ltfConfirmed
    });
    return {
      score: hardOk ? quality.score : Math.min(quality.score, 70),
      factors,
      hardRules,
      rejections: rejections.length ? [...new Set(rejections)] : []
    };
  }
  resolveSetupStatus(setup, quality) {
    if (quality.rejections.length > 0) return "REJECTED";
    if (quality.hardRules.some((h) => h.status === "FAIL")) return "REJECTED";
    return "VALID";
  }
  /** Recent POI/liquidity context used by the strategy layer */
  context(price) {
    const snapshots = this.buildSnapshots();
    const ltfSnap = snapshots[this.cfg.timeframes.ltf];
    const td = this.analyzeTopDownOnly();
    return {
      ht: ltfSnap?.structure.strength ?? "WEAK",
      lastSweep: ltfSnap?.sweeps.at(-1),
      lastChoch: ltfSnap?.choch.at(-1),
      bias: td?.bias ?? "UNCLEAR"
    };
  }
  analyzeTopDownOnly() {
    const htf = this.cfg.timeframes.htf;
    const mtf = this.cfg.timeframes.mtf;
    const ltf = this.cfg.timeframes.ltf;
    const htfSnap = this.engines[htf]?.structure.snapshot();
    const mtfSnap = this.engines[mtf]?.structure.snapshot();
    const ltfSnap = this.engines[ltf]?.structure.snapshot();
    return htfSnap && mtfSnap && ltfSnap ? topDownAnalysis(
      snapshotToBias(htfSnap, htf),
      snapshotToBias(mtfSnap, mtf),
      snapshotToBias(ltfSnap, ltf)
    ) : null;
  }
};

// ../../packages/core/src/execution/paper.ts
var PaperExecutionAdapter = class {
  static {
    __name(this, "PaperExecutionAdapter");
  }
  name = "paper";
  balance;
  fees;
  slippagePct;
  priceProvider;
  orderCounter = 0;
  constructor(opts) {
    this.balance = {
      totalEquity: opts.initialBalance ?? 1e4,
      available: opts.initialBalance ?? 1e4,
      unrealizedPnl: 0
    };
    this.fees = { makerPct: opts.feePct ?? 0.04, takerPct: opts.feePct ?? 0.04 };
    this.slippagePct = opts.slippagePct ?? 0.05;
    this.priceProvider = opts.priceProvider ?? (() => {
      throw new Error("No price provider configured for paper adapter");
    });
  }
  async connect() {
    return { connected: true, message: "Virtual account connected" };
  }
  async validateCredentials() {
    return { valid: true, permissions: { tradingEnabled: true, withdrawalEnabled: false } };
  }
  async getAccountBalance() {
    return { ...this.balance };
  }
  async getAvailableBalance() {
    return this.balance.available;
  }
  async getMarkets() {
    return [];
  }
  async getTicker(symbol) {
    const p = this.priceProvider(symbol);
    if (p === void 0) throw new Error(`No price for ${symbol}`);
    return { price: p };
  }
  async getOHLCV(symbol, timeframe, limit) {
    return [];
  }
  async getTradingRules(symbol) {
    return {
      symbol,
      minQuantity: 1e-4,
      maxQuantity: 1e9,
      stepSize: 1e-4,
      minNotional: 5,
      pricePrecision: 2,
      quantityPrecision: 8
    };
  }
  async getFees() {
    return this.fees;
  }
  async placeOrder(order) {
    this.orderCounter += 1;
    const ref = order.price ?? this.priceProvider(order.symbol);
    if (ref === void 0) {
      return {
        orderId: `P${this.orderCounter}`,
        symbol: order.symbol,
        side: order.side,
        filledPrice: 0,
        filledQuantity: 0,
        status: "REJECTED",
        rejectionReason: "No reference price available"
      };
    }
    const slip = order.side === "BUY" ? 1 + this.slippagePct / 100 : 1 - this.slippagePct / 100;
    const fillPrice = ref * slip;
    const fee = fillPrice * order.quantity * this.fees.takerPct / 100;
    const notional = fillPrice * order.quantity;
    if (order.side === "BUY") {
      this.balance.available -= notional + fee;
    } else {
      this.balance.available += notional - fee;
    }
    this.balance.totalEquity = this.balance.available;
    return {
      orderId: `P${this.orderCounter}`,
      symbol: order.symbol,
      side: order.side,
      filledPrice: fillPrice,
      filledQuantity: order.quantity,
      status: "FILLED"
    };
  }
  async cancelOrder(orderId) {
    return true;
  }
  async getOpenOrders(symbol) {
    return [];
  }
  async closePosition(symbol, side, quantity) {
    return this.placeOrder({
      symbol,
      side: side === "BUY" ? "SELL" : "BUY",
      orderType: "MARKET",
      quantity,
      reduceOnly: true
    });
  }
  async reducePosition(symbol, side, quantity) {
    return this.closePosition(symbol, side, quantity);
  }
  setBalance(b) {
    this.balance = b;
  }
};

// ../../packages/core/src/execution/position-manager.ts
var PositionManager = class {
  static {
    __name(this, "PositionManager");
  }
  opts;
  positions = /* @__PURE__ */ new Map();
  constructor(opts) {
    this.opts = opts;
  }
  /** Apply changed trade-management settings at runtime (BE, partial plan, fees). */
  updateOptions(patch) {
    this.opts = { ...this.opts, ...patch };
  }
  openPosition(input) {
    const id = `POS-${hashString(
      `${input.symbol}:${input.direction}:${input.setupId}:${input.openedAt}`
    )}`;
    const fee = (input.notional ?? input.positionSize * input.entry) * (input.feePct ?? this.opts.feePct) / 100;
    const pos = {
      id,
      symbol: input.symbol,
      exchange: input.exchange,
      direction: input.direction,
      setupId: input.setupId,
      strategyVersion: input.strategyVersion,
      entryModel: input.entryModel,
      plannedRr: input.plannedRr,
      entry: input.entry,
      positionSize: input.positionSize,
      notional: input.notional,
      stopLoss: input.stopLoss,
      takeProfits: input.takeProfits,
      partialPlan: input.partialPlan ?? this.opts.partialPlan,
      currentPrice: input.entry,
      unrealizedPnl: 0,
      openedAt: input.openedAt,
      sl: input.stopLoss,
      quantityRemaining: input.positionSize,
      closedQuantity: 0,
      realizedPnl: 0,
      entryFee: fee,
      events: [
        {
          type: "OPENED",
          timestamp: input.openedAt,
          positionId: id,
          detail: `Position opened at ${input.entry.toFixed(2)}, size ${input.positionSize.toFixed(6)}, SL ${input.stopLoss.toFixed(2)}.`,
          price: input.entry
        }
      ],
      status: "OPEN",
      mae: 0,
      mfe: 0
    };
    this.positions.set(id, pos);
    return pos;
  }
  /** Feed a new price (from the price feed) and process SL/TP logic. */
  onPrice(symbol, price, timestamp) {
    return this.onBar(symbol, { high: price, low: price, close: price }, timestamp);
  }
  /**
   * Process SL/TP logic against a full bar (intrabar approximation).
   * For each position the stop is checked first (conservative), then
   * take-profits in ascending order.
   */
  onBar(symbol, bar, timestamp) {
    const events = [];
    for (const pos of this.positions.values()) {
      if (pos.status !== "OPEN" || pos.symbol !== symbol) continue;
      if (pos.openedAt >= timestamp) continue;
      pos.currentPrice = bar.close;
      pos.unrealizedPnl = this.unrealizedPnl(pos, bar.close);
      const long = pos.direction === "LONG";
      if (long) {
        pos.mae = Math.max(pos.mae, pos.entry - bar.low);
        pos.mfe = Math.max(pos.mfe, bar.high - pos.entry);
      } else {
        pos.mae = Math.max(pos.mae, bar.high - pos.entry);
        pos.mfe = Math.max(pos.mfe, pos.entry - bar.low);
      }
      if (long && bar.low <= pos.sl || !long && bar.high >= pos.sl) {
        const pnl = this.realizedPnlOf(pos, pos.quantityRemaining, pos.sl);
        const ev = {
          type: "STOP_LOSS_HIT",
          timestamp,
          positionId: pos.id,
          detail: `Stop loss hit at ${pos.sl.toFixed(2)}. Remaining ${pos.quantityRemaining.toFixed(6)} closed for ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}.`,
          price: pos.sl,
          qtyClosed: pos.quantityRemaining,
          realizedPnl: pnl
        };
        events.push(ev);
        this.closePosition(pos, pos.quantityRemaining, pos.sl, timestamp, "Stop loss", pnl);
        pos.events.push(ev);
        continue;
      }
      for (let i = 0; i < pos.takeProfits.length; i++) {
        const tp = pos.takeProfits[i];
        if (tp === void 0) continue;
        const hit = long ? bar.high >= tp : bar.low <= tp;
        if (!hit) continue;
        const planItem = pos.partialPlan.find((p) => p.targetIndex === i + 1);
        const isLastTp = i === pos.takeProfits.length - 1;
        const closePct = isLastTp ? 100 : planItem?.closePct ?? 50;
        const qtyToClose = pos.quantityRemaining * closePct / 100;
        if (qtyToClose <= 0) continue;
        const pnl = this.realizedPnlOf(pos, qtyToClose, tp);
        const ev = {
          type: i === 0 ? "TP1_REACHED" : i === 1 ? "TP2_REACHED" : "TP3_REACHED",
          timestamp,
          positionId: pos.id,
          detail: `${i === 0 ? "TP1" : i === 1 ? "TP2" : "TP3"} reached at ${tp.toFixed(2)}. Closing ${closePct}% of remaining position for ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}.`,
          price: tp,
          qtyClosed: qtyToClose,
          realizedPnl: pnl
        };
        events.push(ev);
        this.closePosition(pos, qtyToClose, tp, timestamp, `TP${i + 1}`, pnl);
        pos.events.push(ev);
        if (planItem?.moveSlToBreakEven && this.opts.breakEvenOnTp1) {
          const newSl = pos.entry;
          pos.sl = newSl;
          pos.stopLoss = newSl;
          const ev2 = {
            type: "BREAK_EVEN",
            timestamp,
            positionId: pos.id,
            detail: `SL moved to break-even (${newSl.toFixed(2)}).`,
            price: newSl
          };
          events.push(ev2);
          pos.events.push(ev2);
        }
      }
    }
    return events;
  }
  realizedPnlOf(pos, qty, price) {
    const raw = pos.direction === "LONG" ? (price - pos.entry) * qty : (pos.entry - price) * qty;
    const fee = price * qty * this.opts.feePct / 100;
    return raw - fee;
  }
  unrealizedPnl(pos, price) {
    const raw = pos.direction === "LONG" ? (price - pos.entry) * pos.quantityRemaining : (pos.entry - price) * pos.quantityRemaining;
    return raw;
  }
  closePosition(pos, qty, price, timestamp, reason, pnl) {
    pos.closedQuantity += qty;
    pos.quantityRemaining -= qty;
    pos.realizedPnl += pnl;
    pos.quantityRemaining = Math.max(0, round(pos.quantityRemaining, 8));
    if (pos.quantityRemaining <= 0) {
      pos.status = "CLOSED";
      pos.closeReason = reason;
      pos.closedAt = timestamp;
      pos.finalPnl = pos.realizedPnl - pos.entryFee;
      pos.events.push({
        type: "CLOSED",
        timestamp,
        positionId: pos.id,
        detail: `Position closed (${reason}). Final P/L: ${pos.finalPnl >= 0 ? "+" : ""}${pos.finalPnl.toFixed(2)}.`,
        price,
        realizedPnl: pos.finalPnl
      });
    } else {
      pos.events.push({
        type: "PARTIAL_CLOSE",
        timestamp,
        positionId: pos.id,
        detail: `Partial close of ${qty.toFixed(6)} at ${price.toFixed(2)}. Realized ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}.`,
        price,
        qtyClosed: qty,
        realizedPnl: pnl
      });
    }
  }
  getOpenPositions(symbol) {
    const list = [...this.positions.values()].filter((p) => p.status === "OPEN");
    return symbol ? list.filter((p) => p.symbol === symbol) : list;
  }
  getClosedPositions() {
    return [...this.positions.values()].filter((p) => p.status === "CLOSED");
  }
  getAll() {
    return [...this.positions.values()];
  }
  /**
   * Replace tracked positions with a persisted snapshot. Used when a host that
   * cannot hold the manager in memory indefinitely (such as an evicted Durable
   * Object) rebuilds the engine from storage.
   */
  restore(positions) {
    this.positions = new Map(
      positions.filter((p) => typeof p?.id === "string").map((p) => [p.id, { ...p, events: [...p.events ?? []] }])
    );
  }
  updateSl(symbol, id, newSl, timestamp, reason) {
    const pos = this.positions.get(id);
    if (!pos || pos.symbol !== symbol || pos.status !== "OPEN") return;
    pos.sl = newSl;
    pos.stopLoss = newSl;
    pos.events.push({
      type: "SL_MOVED",
      timestamp,
      positionId: id,
      detail: `${reason}. SL moved to ${newSl.toFixed(2)}.`,
      price: newSl
    });
  }
};

// ../../packages/core/src/journal/journal.ts
var Journal = class {
  static {
    __name(this, "Journal");
  }
  entries = [];
  add(entry) {
    const e = {
      ...entry,
      id: `J-${hashString(`${entry.timestamp}:${entry.category}:${entry.symbol}:${entry.title}`)}`
    };
    this.entries.push(e);
    if (this.entries.length > 2e4) this.entries = this.entries.slice(-2e4);
    return e;
  }
  getAll() {
    return [...this.entries].reverse();
  }
  /**
   * Replace the journal with a persisted snapshot. Entries are stored newest
   * first by `getAll`, so the snapshot is reversed back into insertion order.
   */
  restore(entries) {
    this.entries = [...entries].filter((e) => Number.isFinite(e.timestamp)).sort((a, b) => a.timestamp - b.timestamp).slice(-2e4);
  }
  filter(fn) {
    return [...this.entries].reverse().filter(fn);
  }
  clear() {
    this.entries = [];
  }
};
var ActivityFeed = class {
  static {
    __name(this, "ActivityFeed");
  }
  events = [];
  listeners = [];
  /** Subscribe to every new activity event (feeds the real-time stream). */
  onAdd(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  add(ev) {
    const e = { ...ev, timestamp: Date.now() };
    this.events.push(e);
    if (this.events.length > 5e3) this.events = this.events.slice(-5e3);
    for (const listener of this.listeners) listener(e);
    return e;
  }
  getAll() {
    return [...this.events].reverse();
  }
  /** Replace the feed with a persisted snapshot without notifying listeners. */
  restore(events) {
    this.events = [...events].filter((e) => Number.isFinite(e.timestamp)).sort((a, b) => a.timestamp - b.timestamp).slice(-5e3);
  }
  clear() {
    this.events = [];
  }
};

// ../../packages/core/src/risk/risk-engine.ts
function computePositionSize(input) {
  const slDistance = Math.abs(input.entry - input.stopLoss);
  const riskAmount = input.accountEquity * input.riskPct / 100;
  const warnings = [];
  let positionSize = slDistance > 0 ? riskAmount / slDistance : 0;
  if (input.minQuantity !== void 0 && positionSize < input.minQuantity) {
    warnings.push(`Calculated quantity ${positionSize.toFixed(8)} is below the minimum ${input.minQuantity}.`);
  }
  if (input.stepSize !== void 0 && input.stepSize > 0) {
    positionSize = Math.floor(positionSize / input.stepSize) * input.stepSize;
  }
  const notional = positionSize * input.entry;
  const margin = input.leverage > 0 ? notional / input.leverage : notional;
  return {
    riskPct: input.riskPct,
    accountEquity: input.accountEquity,
    riskAmount,
    entry: input.entry,
    stopLoss: input.stopLoss,
    slDistance,
    positionSize,
    notional,
    margin,
    leverageUsed: margin > 0 ? notional / margin : 0,
    minQuantity: input.minQuantity,
    stepSize: input.stepSize,
    warnings
  };
}
__name(computePositionSize, "computePositionSize");
function checkRr(entry, stopLoss, tp, minRr) {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(tp - entry);
  if (risk <= 0) return 0;
  return reward / risk;
}
__name(checkRr, "checkRr");
var RiskEngine = class {
  static {
    __name(this, "RiskEngine");
  }
  cfg;
  state;
  constructor(cfg, initialState = {}) {
    this.cfg = cfg;
    this.state = {
      symbol: "",
      exchange: "",
      equity: initialState.equity ?? 1e4,
      equityDayStart: initialState.equityDayStart ?? initialState.equity ?? 1e4,
      peakEquity: initialState.peakEquity ?? initialState.equity ?? 1e4,
      tradesToday: initialState.tradesToday ?? 0,
      realizedPnlToday: initialState.realizedPnlToday ?? 0,
      openPositions: initialState.openPositions ?? [],
      usedExposure: initialState.usedExposure ?? 0,
      usedCorrelatedExposure: initialState.usedCorrelatedExposure ?? 0,
      dailyLossReached: initialState.dailyLossReached ?? false,
      drawdownReached: initialState.drawdownReached ?? false
    };
  }
  getState() {
    return { ...this.state };
  }
  setEquity(equity) {
    this.state.equity = equity;
    if (equity > this.state.peakEquity) this.state.peakEquity = equity;
  }
  onTradeExecuted(notional, correlationGroup) {
    this.state.tradesToday += 1;
    this.state.usedExposure += notional;
    if (correlationGroup) this.state.usedCorrelatedExposure += notional;
  }
  onPositionClosed(pnl, notional, correlationGroup) {
    this.state.realizedPnlToday += pnl;
    this.state.equity += pnl;
    this.state.usedExposure = Math.max(0, this.state.usedExposure - notional);
    if (correlationGroup) {
      this.state.usedCorrelatedExposure = Math.max(0, this.state.usedCorrelatedExposure - notional);
    }
    this.refreshLimits();
  }
  /** Refresh daily-loss / drawdown flags from current equity. */
  refreshLimits() {
    const dayStart = this.state.equityDayStart;
    const drawdownFromPeak = dayStart > 0 ? (this.state.peakEquity - this.state.equity) / this.state.peakEquity : 0;
    this.state.drawdownReached = drawdownFromPeak * 100 >= this.cfg.maxDrawdownPct;
    const dailyLoss = dayStart > 0 ? (dayStart - this.state.equity) / dayStart : 0;
    this.state.dailyLossReached = dailyLoss * 100 >= this.cfg.maxDailyLossPct;
  }
  /**
   * Roll over to a new trading day: rebase daily equity, reset daily trade
   * counters and clear the daily-loss flag. Peak equity and drawdown tracking
   * are preserved across the rollover.
   */
  rolloverDay() {
    this.state.equityDayStart = this.state.equity;
    this.state.tradesToday = 0;
    this.state.realizedPnlToday = 0;
    this.state.dailyLossReached = false;
    this.refreshLimits();
  }
  /**
   * Decide whether a proposed trade may proceed. The risk engine has the
   * authority to reject a strategy decision.
   */
  decide(input) {
    this.refreshLimits();
    const reasons = [];
    const limits = [];
    const equity = this.state.equity;
    const remainingTrades = this.cfg.maxTradesPerDay - this.state.tradesToday;
    limits.push({
      kind: "DAILY_TRADE_LIMIT",
      limit: this.cfg.maxTradesPerDay,
      current: this.state.tradesToday,
      allowed: this.state.tradesToday < this.cfg.maxTradesPerDay,
      detail: `${this.state.tradesToday} of ${this.cfg.maxTradesPerDay} trades used today.`
    });
    if (this.state.tradesToday >= this.cfg.maxTradesPerDay) {
      reasons.push({
        kind: "DAILY_TRADE_LIMIT",
        message: `Daily trade limit reached (${this.cfg.maxTradesPerDay}). This is a ceiling, not a target.`
      });
    }
    const dailyLossPct = this.state.equityDayStart > 0 ? (this.state.equityDayStart - this.state.equity) / this.state.equityDayStart * 100 : 0;
    limits.push({
      kind: "DAILY_LOSS_LIMIT",
      limit: this.cfg.maxDailyLossPct,
      current: round(dailyLossPct, 2),
      allowed: dailyLossPct < this.cfg.maxDailyLossPct,
      detail: `Daily loss ${round(dailyLossPct, 2)}% / limit ${this.cfg.maxDailyLossPct}%.`
    });
    if (dailyLossPct >= this.cfg.maxDailyLossPct) {
      reasons.push({
        kind: "DAILY_LOSS_LIMIT",
        message: `Daily loss limit reached (${round(dailyLossPct, 2)}%). No new positions until the limit resets.`
      });
    }
    const ddPct = this.state.peakEquity > 0 ? (this.state.peakEquity - this.state.equity) / this.state.peakEquity * 100 : 0;
    limits.push({
      kind: "MAX_DRAWDOWN",
      limit: this.cfg.maxDrawdownPct,
      current: round(ddPct, 2),
      allowed: ddPct < this.cfg.maxDrawdownPct,
      detail: `Drawdown ${round(ddPct, 2)}% / limit ${this.cfg.maxDrawdownPct}%.`
    });
    if (ddPct >= this.cfg.maxDrawdownPct) {
      reasons.push({
        kind: "MAX_DRAWDOWN",
        message: `Maximum drawdown reached (${round(ddPct, 2)}%). Auto trading halted until intervention.`
      });
    }
    limits.push({
      kind: "MAX_OPEN_POSITIONS",
      limit: this.cfg.maxOpenPositions,
      current: this.state.openPositions.length,
      allowed: this.state.openPositions.length < this.cfg.maxOpenPositions,
      detail: `${this.state.openPositions.length} of ${this.cfg.maxOpenPositions} positions open.`
    });
    if (this.state.openPositions.length >= this.cfg.maxOpenPositions) {
      reasons.push({
        kind: "MAX_OPEN_POSITIONS",
        message: `Maximum open positions reached (${this.cfg.maxOpenPositions}).`
      });
    }
    const leverage = Math.min(input.leverage || this.cfg.maxLeverage, this.cfg.maxLeverage);
    const requested = computePositionSize({
      entry: input.entry,
      stopLoss: input.stopLoss,
      riskPct: this.cfg.riskPerTrade,
      accountEquity: equity,
      leverage,
      minQuantity: input.minQuantity,
      stepSize: input.stepSize
    });
    const headroom = /* @__PURE__ */ __name((limitPct, usedNotional) => Math.max(0, equity * limitPct / 100 - usedNotional), "headroom");
    const notionalCap = Math.min(
      headroom(this.cfg.maxSymbolExposurePct, 0),
      headroom(this.cfg.maxPortfolioExposurePct, this.state.usedExposure),
      headroom(this.cfg.maxCorrelatedExposurePct, this.state.usedCorrelatedExposure)
    );
    let sizing = requested;
    let sizeReducedTo;
    if (requested.notional > notionalCap) {
      const cappedRiskPct = requested.notional > 0 ? this.cfg.riskPerTrade * notionalCap / requested.notional : 0;
      sizing = computePositionSize({
        entry: input.entry,
        stopLoss: input.stopLoss,
        riskPct: cappedRiskPct,
        accountEquity: equity,
        leverage,
        minQuantity: input.minQuantity,
        stepSize: input.stepSize
      });
      sizeReducedTo = cappedRiskPct;
      sizing.warnings.push(
        `Position reduced to respect exposure limits: risking ${round(cappedRiskPct, 3)}% instead of ${this.cfg.riskPerTrade}%.`
      );
    }
    if (sizing.positionSize <= 0 || input.minQuantity !== void 0 && sizing.positionSize < input.minQuantity) {
      reasons.push({
        kind: "MAX_SYMBOL_EXPOSURE",
        message: sizeReducedTo !== void 0 ? `Exposure limits leave room for only ${round(notionalCap, 2)} of notional, below the minimum tradeable size.` : `Calculated position size is below the minimum tradeable size.`
      });
    }
    const symbolExposurePct = sizing.notional / equity * 100;
    limits.push({
      kind: "MAX_SYMBOL_EXPOSURE",
      limit: this.cfg.maxSymbolExposurePct,
      current: round(symbolExposurePct, 2),
      allowed: symbolExposurePct <= this.cfg.maxSymbolExposurePct,
      detail: `Symbol exposure ${round(symbolExposurePct, 2)}% / limit ${this.cfg.maxSymbolExposurePct}%.`
    });
    if (symbolExposurePct > this.cfg.maxSymbolExposurePct) {
      reasons.push({
        kind: "MAX_SYMBOL_EXPOSURE",
        message: `Symbol exposure ${round(symbolExposurePct, 2)}% exceeds the limit of ${this.cfg.maxSymbolExposurePct}%.`
      });
    }
    const totalExposurePct = (this.state.usedExposure + sizing.notional) / equity * 100;
    limits.push({
      kind: "MAX_PORTFOLIO_EXPOSURE",
      limit: this.cfg.maxPortfolioExposurePct,
      current: round(totalExposurePct, 2),
      allowed: totalExposurePct <= this.cfg.maxPortfolioExposurePct,
      detail: `Portfolio exposure ${round(totalExposurePct, 2)}% / limit ${this.cfg.maxPortfolioExposurePct}%.`
    });
    if (totalExposurePct > this.cfg.maxPortfolioExposurePct) {
      reasons.push({
        kind: "MAX_PORTFOLIO_EXPOSURE",
        message: `Portfolio exposure ${round(totalExposurePct, 2)}% exceeds the limit of ${this.cfg.maxPortfolioExposurePct}%.`
      });
    }
    const group = input.correlationGroup || "uncorrelated";
    const correlatedPct = (this.state.usedCorrelatedExposure + sizing.notional) / equity * 100;
    limits.push({
      kind: "MAX_CORRELATED_EXPOSURE",
      limit: this.cfg.maxCorrelatedExposurePct,
      current: round(correlatedPct, 2),
      allowed: correlatedPct <= this.cfg.maxCorrelatedExposurePct,
      detail: `${group} correlated exposure ${round(correlatedPct, 2)}% / limit ${this.cfg.maxCorrelatedExposurePct}%.`
    });
    if (correlatedPct > this.cfg.maxCorrelatedExposurePct) {
      reasons.push({
        kind: "MAX_CORRELATED_EXPOSURE",
        message: `${group} correlated exposure ${round(correlatedPct, 2)}% exceeds the limit of ${this.cfg.maxCorrelatedExposurePct}%.`
      });
    }
    const levUsed = sizing.leverageUsed;
    limits.push({
      kind: "MAX_LEVERAGE",
      limit: this.cfg.maxLeverage,
      current: round(levUsed, 2),
      allowed: levUsed <= this.cfg.maxLeverage + 1e-9,
      detail: `Leverage ${round(levUsed, 2)}x / limit ${this.cfg.maxLeverage}x.`
    });
    if (levUsed > this.cfg.maxLeverage) {
      reasons.push({
        kind: "MAX_LEVERAGE",
        message: `Position requires ${round(levUsed, 2)}x leverage, above the limit of ${this.cfg.maxLeverage}x.`
      });
    }
    const finalTp = input.takeProfits.length ? input.takeProfits.reduce(
      (best, tp) => Math.abs(tp - input.entry) > Math.abs(best - input.entry) ? tp : best,
      input.takeProfits[0]
    ) : 0;
    const finalRr = checkRr(input.entry, input.stopLoss, finalTp, input.minRr);
    limits.push({
      kind: "MIN_RR",
      limit: input.minRr,
      current: round(finalRr, 2),
      allowed: finalRr >= input.minRr,
      detail: `Projected RR to final target 1:${round(finalRr, 2)} / minimum 1:${input.minRr}.`
    });
    if (finalRr < input.minRr) {
      reasons.push({
        kind: "MIN_RR",
        message: `Projected RR to the final target 1:${round(finalRr, 2)} is below the configured minimum 1:${input.minRr}.`
      });
    }
    return {
      allowed: reasons.length === 0,
      reasons,
      limits,
      sizing
    };
  }
  getRemainingTradesToday() {
    return Math.max(0, this.cfg.maxTradesPerDay - this.state.tradesToday);
  }
};

// ../../packages/core/src/explain/explanation.ts
function headlineForStatus(status) {
  switch (status) {
    case "EXECUTED":
      return { headline: "Trade placed.", verdict: "EXECUTED" };
    case "VALID":
      return { headline: "Setup validated \u2014 all mandatory conditions passed.", verdict: "VALIDATED" };
    case "REJECTED":
      return { headline: "Trade not placed.", verdict: "REJECTED" };
    case "STALE":
      return { headline: "Setup invalidated \u2014 the entry is no longer valid.", verdict: "INVALIDATED" };
    case "INVALIDATED":
      return { headline: "Setup invalidated.", verdict: "INVALIDATED" };
    default:
      return { headline: "Setup validating.", verdict: "PENDING" };
  }
}
__name(headlineForStatus, "headlineForStatus");
function explainSetup(setup) {
  const { headline, verdict } = headlineForStatus(setup.status);
  const lines = [];
  for (const rule of setup.hardRules) {
    lines.push({ status: rule.status, ok: rule.status === "PASS" ? true : rule.status === "FAIL" ? false : null, label: rule.name, detail: rule.detail });
  }
  for (const factor of setup.qualityFactors) {
    if (factor.status === "FAIL") {
      lines.push({ status: factor.status, ok: false, label: factor.name, detail: factor.detail });
    }
  }
  for (const factor of setup.qualityFactors) {
    if (factor.status === "PASS" || factor.status === "NEUTRAL") {
      lines.push({ status: factor.status, ok: factor.status === "PASS" ? true : null, label: factor.name, detail: factor.detail });
    }
  }
  if (setup.riskPct > 0 && setup.positionSize !== void 0 && setup.positionSize > 0) {
    lines.push({
      status: "PASS",
      ok: true,
      label: "Risk",
      detail: `Risk ${setup.riskPct}% of equity \u2014 position size ${setup.positionSize.toFixed(8)}.`
    });
  }
  const reasons = setup.reasons.length > 0 ? setup.reasons : lines.filter((l) => l.ok === true).map((l) => l.detail);
  const rejectionReasons = setup.rejectionReasons.length > 0 ? setup.rejectionReasons : [];
  const action = rejectionReasons[0] ?? (verdict === "EXECUTED" ? "Position opened. Monitoring active." : "All mandatory conditions passed \u2014 waiting for execution.");
  return {
    setupId: setup.id,
    symbol: setup.symbol,
    direction: setup.direction,
    entryModel: setup.entryModel,
    status: setup.status,
    verdict,
    headline,
    lines,
    reasons,
    rejectionReasons,
    action
  };
}
__name(explainSetup, "explainSetup");
function explainCycle(input) {
  const setups = input.setups.map(explainSetup);
  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    engineStatus: input.engineStatus,
    message: input.message,
    setups,
    validCount: setups.filter((s) => s.verdict === "VALIDATED" || s.verdict === "EXECUTED").length,
    rejectedCount: setups.filter((s) => s.verdict === "REJECTED" || s.verdict === "INVALIDATED").length
  };
}
__name(explainCycle, "explainCycle");

// ../../packages/core/src/strategy/strategy-engine.ts
var StrategyEngine = class {
  static {
    __name(this, "StrategyEngine");
  }
  analysis;
  riskEngine;
  positionManager;
  journal;
  activity;
  strategyCfg;
  riskCfg;
  mode;
  execution;
  executedFingerprints = /* @__PURE__ */ new Map();
  pendingKeys = /* @__PURE__ */ new Set();
  pendingSubmissions = [];
  autoTrading = true;
  safetyBlocked = false;
  dailyCounter = { dayKey: "", count: 0 };
  lastSeenTs = 0;
  constructor(opts) {
    this.strategyCfg = opts.strategy;
    this.riskCfg = validateRiskConfig(opts.risk);
    this.mode = opts.mode;
    this.execution = opts.execution ?? (opts.mode === "PAPER" ? new PaperExecutionAdapter({
      initialBalance: opts.startingEquity ?? 1e4,
      feePct: this.riskCfg.feePct,
      slippagePct: this.riskCfg.slippagePct
    }) : void 0);
    this.analysis = opts.analysis ?? new AnalysisEngine(
      opts.strategy.symbol,
      opts.strategy.exchange,
      opts.strategy
    );
    this.riskEngine = new RiskEngine(this.riskCfg, {
      equity: opts.startingEquity ?? 1e4,
      equityDayStart: opts.startingEquity ?? 1e4,
      peakEquity: opts.startingEquity ?? 1e4
    });
    this.positionManager = new PositionManager({
      feePct: this.riskCfg.feePct,
      slippagePct: this.riskCfg.slippagePct,
      breakEvenOnTp1: this.strategyCfg.breakEvenOnTp1,
      partialPlan: this.strategyCfg.partialClosePlan
    });
    this.journal = new Journal();
    this.activity = new ActivityFeed();
  }
  getJournal() {
    return this.journal;
  }
  getActivity() {
    return this.activity;
  }
  getPositions() {
    return this.positionManager.getAll();
  }
  getOpenPositions() {
    return this.positionManager.getOpenPositions();
  }
  getRiskState() {
    return this.riskEngine.getState();
  }
  get riskLimits() {
    return this.riskCfg;
  }
  get strategyConfig() {
    return { ...this.strategyCfg };
  }
  /**
   * Apply a new validated+clamped risk configuration at runtime. Equity and
   * daily counters are preserved; only the limit/sizing parameters change.
   */
  updateRiskConfig(cfg) {
    const next = validateRiskConfig(cfg);
    const state = this.riskEngine.getState();
    this.riskCfg = next;
    this.riskEngine = new RiskEngine(next, {
      equity: state.equity,
      equityDayStart: state.equityDayStart,
      peakEquity: state.peakEquity,
      tradesToday: state.tradesToday,
      realizedPnlToday: state.realizedPnlToday,
      openPositions: state.openPositions,
      usedExposure: state.usedExposure,
      usedCorrelatedExposure: state.usedCorrelatedExposure,
      dailyLossReached: state.dailyLossReached,
      drawdownReached: state.drawdownReached
    });
    this.positionManager.updateOptions({
      breakEvenOnTp1: this.strategyCfg.breakEvenOnTp1,
      partialPlan: this.strategyCfg.partialClosePlan
    });
    this.activity.add({
      kind: "config",
      symbol: this.strategyCfg.symbol,
      detail: `Risk configuration updated: ${next.maxTradesPerDay} trades/day max, ${next.riskPerTrade}% risk/trade, ${next.maxDailyLossPct}% daily loss, ${next.maxDrawdownPct}% drawdown.`,
      level: "info"
    });
  }
  /**
   * Apply a new strategy configuration at runtime. Structural fields
   * (symbol, exchange, timeframes, swing detection) are rejected by the
   * analysis engine; other settings take effect immediately.
   */
  updateStrategyConfig(cfg) {
    this.analysis.updateConfig(cfg);
    this.strategyCfg = cfg;
    this.positionManager.updateOptions({
      breakEvenOnTp1: cfg.breakEvenOnTp1,
      partialPlan: cfg.partialClosePlan
    });
    this.activity.add({
      kind: "config",
      symbol: cfg.symbol,
      detail: `Strategy configuration updated: ${cfg.name} (${cfg.version}).`,
      level: "info"
    });
  }
  setMode(mode) {
    this.mode = mode;
    this.activity.add({
      kind: "mode",
      symbol: this.strategyCfg.symbol,
      detail: `Trading mode set to ${mode}.`,
      level: "info"
    });
  }
  getMode() {
    return this.mode;
  }
  setExecution(execution) {
    this.execution = execution;
    if (execution) {
      this.activity.add({
        kind: "exchange",
        symbol: this.strategyCfg.symbol,
        detail: `Execution adapter connected: ${execution.name}.`,
        level: "success"
      });
    }
  }
  setAutoTrading(enabled) {
    this.autoTrading = enabled;
    this.activity.add({
      kind: "autotrading",
      symbol: this.strategyCfg.symbol,
      detail: enabled ? "Auto trading ENABLED." : "Auto trading STOPPED \u2014 no new trades will be opened.",
      level: enabled ? "success" : "danger"
    });
  }
  isAutoTrading() {
    return this.autoTrading;
  }
  /** Emergency safe mode: halts new trades until explicitly lifted. */
  enterSafeMode(reason) {
    this.safetyBlocked = true;
    this.activity.add({
      kind: "safemode",
      symbol: this.strategyCfg.symbol,
      detail: `SAFE MODE: ${reason}`,
      level: "danger"
    });
    this.journal.add({
      timestamp: Date.now(),
      symbol: this.strategyCfg.symbol,
      category: "SYSTEM_EVENT",
      title: "Safe mode entered",
      body: reason
    });
  }
  exitSafeMode() {
    this.safetyBlocked = false;
    this.activity.add({
      kind: "safemode",
      symbol: this.strategyCfg.symbol,
      detail: "Safe mode cleared. New trades allowed again.",
      level: "success"
    });
  }
  isSafetyBlocked() {
    return this.safetyBlocked;
  }
  /**
   * Capture execution and risk state so a host that cannot keep the engine in
   * memory (an evicted Durable Object, a restarted worker) can resume without
   * losing open positions, the audit trail, or duplicate-trade protection.
   */
  serialize() {
    const risk = this.riskEngine.getState();
    return {
      version: 1,
      positions: this.positionManager.getAll(),
      journal: this.journal.getAll(),
      activity: this.activity.getAll(),
      risk: {
        equity: risk.equity,
        equityDayStart: risk.equityDayStart,
        peakEquity: risk.peakEquity,
        tradesToday: risk.tradesToday,
        realizedPnlToday: risk.realizedPnlToday,
        usedExposure: risk.usedExposure,
        usedCorrelatedExposure: risk.usedCorrelatedExposure,
        dailyLossReached: risk.dailyLossReached,
        drawdownReached: risk.drawdownReached
      },
      executedFingerprints: [...this.executedFingerprints.entries()],
      dailyCounter: { ...this.dailyCounter },
      lastSeenTs: this.lastSeenTs,
      autoTrading: this.autoTrading,
      safetyBlocked: this.safetyBlocked
    };
  }
  /**
   * Restore a snapshot produced by {@link serialize}. Restoring never opens or
   * closes a position; it only reinstates state the engine had already decided.
   */
  restore(snapshot) {
    if (snapshot?.version !== 1) {
      throw new Error("Unsupported strategy engine snapshot version.");
    }
    this.positionManager.restore(snapshot.positions ?? []);
    this.journal.restore(snapshot.journal ?? []);
    this.activity.restore(snapshot.activity ?? []);
    const openPositions = this.positionManager.getOpenPositions();
    this.riskEngine = new RiskEngine(this.riskCfg, {
      equity: snapshot.risk.equity,
      equityDayStart: snapshot.risk.equityDayStart,
      peakEquity: snapshot.risk.peakEquity,
      tradesToday: snapshot.risk.tradesToday,
      realizedPnlToday: snapshot.risk.realizedPnlToday,
      openPositions,
      usedExposure: snapshot.risk.usedExposure,
      usedCorrelatedExposure: snapshot.risk.usedCorrelatedExposure,
      dailyLossReached: snapshot.risk.dailyLossReached,
      drawdownReached: snapshot.risk.drawdownReached
    });
    this.executedFingerprints = new Map(snapshot.executedFingerprints ?? []);
    this.dailyCounter = { ...snapshot.dailyCounter };
    this.lastSeenTs = snapshot.lastSeenTs ?? 0;
    this.autoTrading = snapshot.autoTrading;
    this.safetyBlocked = snapshot.safetyBlocked;
  }
  /** Feed a closed candle and run the full decision pipeline. */
  onCandleClosed(candle) {
    if (candle.timestamp > this.lastSeenTs) this.lastSeenTs = candle.timestamp;
    this.analysis.onCandleClosed(candle);
    const analysis = this.analysis.analyze();
    return this.processCycle(analysis);
  }
  /** Re-run the decision pipeline on the current state (used for price-only ticks). */
  reevaluate(price) {
    const analysis = this.analysis.analyze();
    return this.processCycle(analysis, price);
  }
  processCycle(analysis, currentPrice) {
    const now = analysis.updatedAt;
    const symbol = analysis.symbol;
    const decisions = [];
    const rejectedSetups = [];
    const validSetups = [];
    const allValid = analysis.setups.filter((s) => s.status === "VALID");
    const remaining = this.remainingTradesToday();
    this.pendingKeys.clear();
    const eligible = [];
    for (const setup of allValid) {
      const dup = this.isDuplicate(setup);
      if (dup) {
        setup.status = "INVALIDATED";
        setup.rejectionReasons = ["Duplicate setup \u2014 this setup was already executed or is already active."];
        rejectedSetups.push(setup);
        this.journal.add({
          timestamp: now,
          symbol,
          category: "REJECTED_SETUP",
          title: "Duplicate setup blocked",
          body: `${setup.direction} ${setup.entryModel} at ${round(setup.entry, 4)} rejected: identical setup already handled.`,
          data: { setupId: setup.id }
        });
        continue;
      }
      const stale = this.isStale(setup, currentPrice);
      if (stale) {
        setup.status = "STALE";
        setup.rejectionReasons = ["Stale setup \u2014 price has moved or the setup exceeded its validity window."];
        rejectedSetups.push(setup);
        this.journal.add({
          timestamp: now,
          symbol,
          category: "REJECTED_SETUP",
          title: "Stale setup invalidated",
          body: stale,
          data: { setupId: setup.id }
        });
        continue;
      }
      validSetups.push(setup);
      eligible.push({ setup });
    }
    eligible.sort((a, b) => {
      if (b.setup.score !== a.setup.score) return b.setup.score - a.setup.score;
      const alignA = a.setup.components.chochEvent ? 1 : 0;
      const alignB = b.setup.components.chochEvent ? 1 : 0;
      if (alignB !== alignA) return alignB - alignA;
      return a.setup.createdAt - b.setup.createdAt;
    });
    const takeCount = Math.max(0, Math.min(eligible.length, remaining));
    const capped = eligible.slice(0, takeCount);
    const overflow = eligible.slice(takeCount);
    let message;
    if (eligible.length > takeCount) {
      message = `${eligible.length} valid setups found. User daily limit: ${this.riskCfg.maxTradesPerDay} (${this.usedToday()} used). The ${takeCount} highest-priority setups were eligible for execution.`;
    } else if (eligible.length > 0 && takeCount === 0) {
      message = `${eligible.length} valid setups found but the daily trade limit has been reached.`;
    }
    if (eligible.length === 0) {
      message = `No valid setups this cycle. Trade count is never forced; the limit is a ceiling, not a target.`;
    }
    for (const overflowSetup of overflow) {
      overflowSetup.setup.status = "REJECTED";
      overflowSetup.setup.rejectionReasons = [
        `Daily trade limit reached (${this.riskCfg.maxTradesPerDay}). This setup was valid but exceeded the configured daily ceiling.`
      ];
      rejectedSetups.push(overflowSetup.setup);
      this.journal.add({
        timestamp: now,
        symbol,
        category: "REJECTED_SETUP",
        title: "Valid setup not traded \u2014 daily ceiling",
        body: `${overflowSetup.setup.direction} setup with score ${overflowSetup.setup.score} was valid but the daily trade limit of ${this.riskCfg.maxTradesPerDay} was already used.`,
        data: { setupId: overflowSetup.setup.id }
      });
    }
    for (const { setup } of capped) {
      this.pendingKeys.add(this.fingerprintOf(setup));
      const decision = this.decideAndExecute(setup, now, currentPrice);
      decisions.push(decision);
    }
    const status = this.computeEngineStatus(decisions, eligible.length, takeCount);
    const allSetups = [...validSetups, ...rejectedSetups];
    const uniqueSetups = allSetups.filter(
      (s, i) => allSetups.findIndex((x) => x.id === s.id) === i
    );
    return {
      symbol,
      exchange: this.strategyCfg.exchange,
      timestamp: now,
      status,
      decisions,
      rejectedSetups,
      validSetups,
      message,
      explanation: explainCycle({
        symbol,
        timestamp: now,
        engineStatus: status,
        message,
        setups: uniqueSetups
      })
    };
  }
  decideAndExecute(setup, now, currentPrice) {
    const symbol = this.strategyCfg.symbol;
    const long = setup.direction === "LONG";
    if (this.safetyBlocked) {
      setup.status = "REJECTED";
      setup.rejectionReasons = ["System is in safe mode."];
      return this.reject(setup, ["System is in safe mode."]);
    }
    if (!this.autoTrading) {
      setup.status = "REJECTED";
      setup.rejectionReasons = ["Auto trading is disabled. No new orders."];
      return this.reject(setup, ["Auto trading is disabled. No new orders."]);
    }
    const group = this.riskCfg.correlationGroups[setup.symbol] ?? "uncorrelated";
    const riskDecision = this.riskEngine.decide({
      symbol,
      direction: setup.direction,
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfits: setup.takeProfits,
      minRr: this.minRrFor(setup),
      leverage: this.riskCfg.maxLeverage,
      minQuantity: 1e-4,
      stepSize: 1e-4,
      correlationGroup: group
    });
    if (!riskDecision.allowed) {
      setup.status = "REJECTED";
      setup.rejectionReasons = riskDecision.reasons.map((r) => r.message);
      setup.riskPct = this.riskCfg.riskPerTrade;
      const kind = riskDecision.reasons[0]?.kind;
      const jCategory = kind === "DAILY_TRADE_LIMIT" ? "RISK_EVENT" : kind === "DAILY_LOSS_LIMIT" || kind === "MAX_DRAWDOWN" ? "RISK_EVENT" : "RISK_EVENT";
      this.journal.add({
        timestamp: now,
        symbol,
        category: jCategory,
        title: "Setup rejected by risk engine",
        body: setup.rejectionReasons.join(" "),
        data: { setupId: setup.id }
      });
      if (kind === "DAILY_LOSS_LIMIT") {
        this.activity.add({
          kind: "risk",
          symbol,
          detail: "Daily loss limit reached \u2014 no new positions until reset.",
          level: "danger"
        });
      }
      return this.reject(setup, setup.rejectionReasons);
    }
    const sizing = riskDecision.sizing;
    setup.riskPct = this.riskCfg.riskPerTrade;
    setup.positionSize = sizing.positionSize;
    const price = currentPrice ?? this.lastPrice();
    if (price === void 0) {
      return this.reject(setup, ["No current price available."]);
    }
    const preflight = this.preflight(setup, price, sizing.positionSize);
    if (!preflight.ok) {
      const reason = preflight.reason ?? "Preflight failed";
      setup.status = "REJECTED";
      setup.rejectionReasons = [reason];
      this.journal.add({
        timestamp: now,
        symbol,
        category: "ORDER",
        title: "Preflight failed",
        body: reason,
        data: { setupId: setup.id }
      });
      return this.reject(setup, [reason]);
    }
    const side = long ? "BUY" : "SELL";
    const decision = {
      decision: "EXECUTE",
      symbol,
      exchange: this.strategyCfg.exchange,
      side,
      orderType: "LIMIT",
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfits: setup.takeProfits,
      quantity: sizing.positionSize,
      riskAmount: sizing.riskAmount,
      rr: setup.rr,
      setupId: setup.id,
      strategyVersion: setup.strategyVersion,
      entryModel: setup.entryModel
    };
    void this.pendingSubmissions.push(this.submitOrder(decision, setup, now));
    this.recordFingerprint(setup);
    return decision;
  }
  /**
   * Await any in-flight order submissions (used by the backtest replay loop so
   * positions open before the next bar is processed).
   */
  async flush() {
    const pending = this.pendingSubmissions;
    this.pendingSubmissions = [];
    await Promise.all(pending);
  }
  async submitOrder(decision, setup, now) {
    if (decision.decision !== "EXECUTE") return;
    if (this.mode === "ANALYSIS_ONLY") {
      setup.status = "VALID";
      setup.reasons = [...setup.reasons ?? [], "Analysis-only mode \u2014 setup validated, no order submitted."];
      this.journal.add({
        timestamp: now,
        symbol: setup.symbol,
        category: "SYSTEM_EVENT",
        title: "Setup validated (analysis only)",
        body: `${setup.direction} ${setup.entryModel} validated with score ${setup.score}. No order submitted in analysis-only mode.`,
        data: { setupId: setup.id }
      });
      return;
    }
    if (!this.execution) {
      if (this.mode === "PAPER") {
        this.execution = new PaperExecutionAdapter({
          initialBalance: this.riskEngine.getState().equity,
          feePct: this.riskCfg.feePct,
          slippagePct: this.riskCfg.slippagePct
        });
        this.activity.add({
          kind: "exchange",
          symbol: setup.symbol,
          detail: "Paper execution adapter initialised.",
          level: "success"
        });
      } else {
        setup.status = "REJECTED";
        setup.rejectionReasons = ["Exchange not connected. Connect an exchange to trade."];
        return;
      }
    }
    try {
      const result = await this.execution.placeOrder({
        symbol: decision.symbol,
        side: decision.side,
        orderType: decision.orderType,
        quantity: decision.quantity,
        price: decision.entry,
        stopLoss: decision.stopLoss,
        takeProfits: decision.takeProfits
      });
      if (result.status === "FILLED") {
        setup.status = "EXECUTED";
        const notional = result.filledQuantity * result.filledPrice;
        const group = this.riskCfg.correlationGroups[setup.symbol] ?? "uncorrelated";
        this.riskEngine.onTradeExecuted(notional, group);
        this.bumpDailyCounter(now);
        const pos = this.positionManager.openPosition({
          symbol: setup.symbol,
          exchange: this.strategyCfg.exchange,
          direction: setup.direction,
          setupId: setup.id,
          strategyVersion: setup.strategyVersion,
          entryModel: setup.entryModel,
          plannedRr: setup.rr,
          entry: result.filledPrice,
          positionSize: result.filledQuantity,
          notional,
          stopLoss: decision.stopLoss,
          takeProfits: decision.takeProfits,
          openedAt: now + timeframeDuration(this.strategyCfg.timeframes.ltf)
        });
        this.journal.add({
          timestamp: now,
          symbol: setup.symbol,
          category: "TRADE",
          title: `${setup.direction} trade opened`,
          body: this.describeSetup(setup, result.filledPrice),
          data: { setupId: setup.id, orderId: result.orderId, positionId: pos.id, decision }
        });
        this.activity.add({
          kind: "trade",
          symbol: setup.symbol,
          detail: `${setup.direction} ${setup.entryModel} order filled at ${result.filledPrice.toFixed(2)}. Position ${pos.id}.`,
          level: "success"
        });
      } else {
        setup.status = "REJECTED";
        setup.rejectionReasons = [`Order failed: ${result.rejectionReason ?? "rejected by exchange"}`];
        this.journal.add({
          timestamp: now,
          symbol: setup.symbol,
          category: "ORDER",
          title: "Order failed",
          body: result.rejectionReason ?? "Exchange rejected the order.",
          data: { setupId: setup.id }
        });
      }
    } catch (err) {
      setup.status = "REJECTED";
      setup.rejectionReasons = [`Order error: ${err instanceof Error ? err.message : String(err)}`];
      this.journal.add({
        timestamp: now,
        symbol: setup.symbol,
        category: "ERROR",
        title: "Order error",
        body: err instanceof Error ? err.message : String(err),
        data: { setupId: setup.id }
      });
    }
  }
  /** Preflight safety checks immediately before submission (section 97). */
  preflight(setup, price, quantity) {
    const checks = [
      ["Exchange connected", !!this.execution, "Exchange is not connected."],
      ["Market data available", price > 0, "No current market price."],
      ["Price current", Math.abs(price - setup.entry) / setup.entry <= 0.03, `Current price ${price.toFixed(2)} is too far from the setup entry ${setup.entry.toFixed(2)}.`],
      ["Setup still valid", setup.status === "VALID" || setup.status === "VALIDATING", "Setup is no longer valid."],
      ["Risk approved", setup.riskPct > 0, "Risk parameters were not approved."],
      ["Quantity valid", quantity > 0, "Position quantity is zero or negative."],
      ["Stop loss valid", setup.stopLoss > 0 && Math.abs(setup.stopLoss - setup.entry) > 0, "Stop loss is not structurally valid."],
      ["Take profits valid", setup.takeProfits.length > 0 && setup.takeProfits[0] > 0, "No valid take-profit targets."],
      // Judged on the final target, matching the analysis engine's hard rule.
      ["RR valid", (setup.rr.length ? Math.max(...setup.rr) : 0) >= this.minRrFor(setup), "Projected RR is below the configured minimum."]
    ];
    for (const [, ok, reason] of checks) {
      if (!ok) return { ok: false, reason };
    }
    return { ok: true };
  }
  minRrFor(setup) {
    return setup.counterTrend ? this.strategyCfg.minRr * this.strategyCfg.counterTrendMinRrMultiplier : this.strategyCfg.minRr;
  }
  isDuplicate(setup) {
    const key = this.fingerprintOf(setup);
    if (this.pendingKeys.has(key)) return true;
    const last = this.executedFingerprints.get(key);
    if (last !== void 0) {
      return true;
    }
    return this.positionManager.getOpenPositions().some((p) => p.symbol === setup.symbol && p.direction === setup.direction && p.setupId !== setup.id);
  }
  fingerprintOf(setup) {
    return `${setup.symbol}:${setup.direction}:${setup.entryModel}:${setup.components.poi?.id}`;
  }
  isStale(setup, currentPrice) {
    const price = currentPrice ?? this.lastPrice();
    if (setup.createdAt > 0 && this.nowMs() - setup.createdAt > this.strategyCfg.setupMaxAgeMs) {
      return "Setup exceeded its maximum validity window.";
    }
    if (price !== void 0) {
      const drift = Math.abs(price - setup.entry) / setup.entry;
      if (drift > 0.04) {
        return `Price moved ${(drift * 100).toFixed(1)}% away from the setup entry - the original entry is no longer valid.`;
      }
    }
    return null;
  }
  lastPrice() {
    const ltf = this.strategyCfg.timeframes.ltf;
    const buf = this.analysis.candlesFor(ltf);
    const last = buf[buf.length - 1];
    return last?.close;
  }
  nowMs() {
    return this.lastSeenTs > 0 ? this.lastSeenTs : Date.now();
  }
  recordFingerprint(setup) {
    this.executedFingerprints.set(this.fingerprintOf(setup), Date.now());
  }
  describeSetup(setup, price) {
    return [
      `${setup.direction} ${setup.entryModel} executed at ${price.toFixed(2)}.`,
      `Stop loss ${setup.stopLoss.toFixed(2)} (${setup.stopLossReason})`,
      `Take profits: ${setup.takeProfits.map((t, i) => `TP${i + 1}=${t.toFixed(2)}`).join(", ")}.`,
      `RR: ${setup.rr.map((r) => `1:${r.toFixed(1)}`).join(" / ")}.`,
      `Setup score: ${setup.score}/100.`,
      `Strategy version: ${setup.strategyVersion}.`
    ].join(" ");
  }
  reject(setup, reasons) {
    return { decision: "REJECT", setupId: setup.id, reasons };
  }
  computeEngineStatus(decisions, validCount, taken) {
    if (this.safetyBlocked) return "SAFE_MODE";
    if (decisions.some((d) => d.decision === "EXECUTE")) return "ORDER_SUBMITTED";
    if (taken === 0 && validCount > 0) return "DAILY_LIMIT_REACHED";
    if (validCount > 0) return "READY";
    return "SCANNING";
  }
  // ------------------------------------------------------------------
  // Daily counters (independent of wall-clock day; reset by caller)
  // ------------------------------------------------------------------
  usedToday() {
    return this.riskEngine.getState().tradesToday;
  }
  remainingTradesToday() {
    return this.riskEngine.getRemainingTradesToday();
  }
  bumpDailyCounter(ts) {
    const day = new Date(ts).toISOString().slice(0, 10);
    if (this.dailyCounter.dayKey !== day) {
      this.dailyCounter = { dayKey: day, count: 0 };
    }
    this.dailyCounter.count += 1;
  }
  /** Advance the trading day (called by the scheduler at midnight). */
  rolloverDay(now) {
    this.riskEngine.rolloverDay();
    this.bumpDailyCounter(now);
    this.activity.add({
      kind: "risk",
      symbol: this.strategyCfg.symbol,
      detail: "Trading day rolled over. Daily loss/trade limits reset.",
      level: "info"
    });
    this.journal.add({
      timestamp: now,
      symbol: this.strategyCfg.symbol,
      category: "SYSTEM_EVENT",
      title: "Daily rollover",
      body: "New trading day. Daily loss and trade counters reset."
    });
  }
  /** Record a price tick so open positions are managed. */
  onPriceTick(symbol, price, timestamp) {
    if (timestamp > this.lastSeenTs) this.lastSeenTs = timestamp;
    this.handlePositionEvents(
      symbol,
      this.positionManager.onPrice(symbol, price, timestamp),
      timestamp
    );
  }
  /** Record a full bar so open positions are managed with intrabar precision. */
  onPriceBar(symbol, bar, timestamp) {
    if (timestamp > this.lastSeenTs) this.lastSeenTs = timestamp;
    this.handlePositionEvents(
      symbol,
      this.positionManager.onBar(symbol, bar, timestamp),
      timestamp
    );
  }
  handlePositionEvents(symbol, events, timestamp) {
    for (const ev of events) {
      this.activity.add({
        kind: "position",
        symbol,
        detail: ev.detail,
        level: ev.type === "STOP_LOSS_HIT" || ev.type === "CLOSED" ? ev.realizedPnl !== void 0 && ev.realizedPnl < 0 ? "danger" : "success" : "info"
      });
      if (ev.type === "STOP_LOSS_HIT" || ev.type === "CLOSED") {
        this.journal.add({
          timestamp,
          symbol,
          category: "TRADE",
          title: ev.type,
          body: ev.detail
        });
      }
      if (ev.type === "CLOSED" && ev.realizedPnl !== void 0) {
        const closed = this.positionManager.getAll().find((p) => p.id === ev.positionId);
        if (closed) {
          this.riskEngine.onPositionClosed(ev.realizedPnl, closed.notional, this.riskCfg.correlationGroups[symbol] ?? "uncorrelated");
        }
      }
    }
  }
  /** Close a position fully and update risk state. */
  async closePosition(positionId, price, timestamp) {
    const pos = this.positionManager.getAll().find((p) => p.id === positionId);
    if (!pos) return;
    if (this.execution && this.mode !== "ANALYSIS_ONLY") {
      await this.execution.closePosition(pos.symbol, pos.direction === "LONG" ? "BUY" : "SELL", pos.quantityRemaining);
    }
    const pnl = pos.realizedPnl;
    this.positionManager.onPrice(pos.symbol, price, timestamp);
    this.riskEngine.onPositionClosed(pnl, pos.notional, this.riskCfg.correlationGroups[pos.symbol] ?? "uncorrelated");
    this.activity.add({
      kind: "position",
      symbol: pos.symbol,
      detail: `Position ${positionId} closed at ${price.toFixed(2)}.`,
      level: pnl >= 0 ? "success" : "danger"
    });
  }
};

// ../../packages/core/src/execution/binance.ts
import { createHmac } from "node:crypto";

// ../../packages/core/src/marketdata/multi-exchange.ts
var MultiExchangeMarketData = class {
  static {
    __name(this, "MultiExchangeMarketData");
  }
  name = "multi-exchange";
  exchanges;
  fetchFn;
  timeoutMs;
  constructor(opts = {}) {
    this.exchanges = opts.exchanges?.length ? opts.exchanges : ["binance", "bybit", "bitget", "okx", "kucoin"];
    this.fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = Math.max(1e3, opts.timeoutMs ?? 8e3);
  }
  async getOHLCV(symbol, timeframe, startTime, endTime, limit = 1e3) {
    return this.withFallback("candles", async (exchange) => this.candles(exchange, symbol, timeframe, startTime, endTime, limit));
  }
  async getTicker(symbol) {
    return this.withFallback("ticker", async (exchange) => this.ticker(exchange, symbol));
  }
  async getMarkets() {
    return this.withFallback("markets", async (exchange) => this.markets(exchange));
  }
  async withFallback(operation, action) {
    const failures = [];
    for (const exchange of this.exchanges) {
      try {
        return await action(exchange);
      } catch (err) {
        failures.push(`${exchange}: ${describeError(err)}`);
      }
    }
    throw new Error(`Public market-data ${operation} unavailable across ${this.exchanges.join(", ")}. ${failures.join("; ")}`);
  }
  async candles(exchange, symbol, timeframe, start, end, limit) {
    const url = this.candleUrl(exchange, symbol, timeframe, start, end, limit);
    const data = await this.json(url);
    const rows = exchange === "binance" ? data : exchange === "bybit" ? data.result?.list ?? [] : exchange === "bitget" ? data.data ?? [] : exchange === "okx" ? data.data ?? [] : data.data ?? [];
    const candles = rows.map((row) => parseCandle(exchange, symbol, timeframe, row)).filter((c) => c !== null);
    if (!candles.length) throw new Error("returned no candles");
    return candles.sort((a, b) => a.timestamp - b.timestamp);
  }
  async ticker(exchange, symbol) {
    const data = await this.json(this.tickerUrl(exchange, symbol));
    const price = exchange === "binance" ? Number(data.price) : exchange === "bybit" ? Number(data.result?.list?.[0]?.lastPrice) : exchange === "bitget" ? Number(data.data?.[0]?.lastPr) : exchange === "okx" ? Number(data.data?.[0]?.last) : Number(data.data?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("returned an invalid ticker price");
    return { price };
  }
  async markets(exchange) {
    const data = await this.json(this.marketUrl(exchange));
    const symbols = exchange === "binance" ? data.symbols?.filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT").map((s) => s.symbol) ?? [] : exchange === "bybit" ? data.result?.list?.filter((s) => s.status === "Trading").map((s) => s.symbol) ?? [] : exchange === "bitget" ? data.data?.filter((s) => s.status === "online").map((s) => s.symbol.replace(/USDT$/, "USDT")) ?? [] : exchange === "okx" ? data.data?.filter((s) => s.state === "live").map((s) => s.instId.replace("-", "")) ?? [] : data.data?.filter((s) => s.enableTrading).map((s) => s.symbol.replace("-", "")) ?? [];
    if (!symbols.length) throw new Error("returned no active USDT markets");
    return symbols;
  }
  candleUrl(exchange, symbol, tf, start, end, limit) {
    const pair = normalizeSymbol(exchange, symbol);
    const interval = intervalFor(exchange, tf);
    if (exchange === "binance") return `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${start}&endTime=${end}&limit=${Math.min(limit, 1e3)}`;
    if (exchange === "bybit") return `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${interval}&start=${start}&end=${end}&limit=${Math.min(limit, 1e3)}`;
    if (exchange === "bitget") return `https://api.bitget.com/api/v2/spot/market/candles?symbol=${pair}&granularity=${interval}&startTime=${start}&endTime=${end}&limit=${Math.min(limit, 1e3)}`;
    if (exchange === "okx") return `https://www.okx.com/api/v5/market/candles?instId=${pair}&bar=${interval}&before=${end}&after=${start}&limit=${Math.min(limit, 300)}`;
    return `https://api.kucoin.com/api/v1/market/candles?symbol=${pair}&type=${interval}&startAt=${Math.floor(start / 1e3)}&endAt=${Math.floor(end / 1e3)}`;
  }
  tickerUrl(exchange, symbol) {
    const pair = normalizeSymbol(exchange, symbol);
    if (exchange === "binance") return `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
    if (exchange === "bybit") return `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`;
    if (exchange === "bitget") return `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${pair}`;
    if (exchange === "okx") return `https://www.okx.com/api/v5/market/ticker?instId=${pair}`;
    return `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${pair}`;
  }
  marketUrl(exchange) {
    if (exchange === "binance") return "https://api.binance.com/api/v3/exchangeInfo";
    if (exchange === "bybit") return "https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000";
    if (exchange === "bitget") return "https://api.bitget.com/api/v2/spot/public/symbols";
    if (exchange === "okx") return "https://www.okx.com/api/v5/public/instruments?instType=SPOT";
    return "https://api.kucoin.com/api/v2/symbols";
  }
  async json(url) {
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
};
function normalizeSymbol(exchange, symbol) {
  const clean = symbol.replace("/", "").toUpperCase();
  if (exchange === "okx" || exchange === "kucoin") return clean.replace(/(USDT|USDC|BTC|ETH)$/, "-$1");
  return clean;
}
__name(normalizeSymbol, "normalizeSymbol");
function intervalFor(exchange, tf) {
  const minute = { "5M": "5", "15M": "15", "30M": "30", "1H": "60", "2H": "120", "4H": "240", "1D": "D" }[tf];
  if (exchange === "binance") return { "5M": "5m", "15M": "15m", "30M": "30m", "1H": "1h", "2H": "2h", "4H": "4h", "1D": "1d" }[tf];
  if (exchange === "bitget") return tf === "1D" ? "1day" : `${minute}min`;
  if (exchange === "okx") return tf === "1D" ? "1D" : `${minute}m`;
  if (exchange === "kucoin") return tf === "1D" ? "1day" : `${minute}min`;
  return minute;
}
__name(intervalFor, "intervalFor");
function parseCandle(exchange, symbol, timeframe, row) {
  const values = exchange === "kucoin" ? [row[0], row[1], row[3], row[4], row[2], row[5]] : row;
  const timestamp = Number(values[0]) * (exchange === "kucoin" ? 1e3 : 1);
  const open = Number(values[1]), high = Number(values[2]), low = Number(values[3]), close = Number(values[4]), volume = Number(values[5]);
  if (![timestamp, open, high, low, close, volume].every(Number.isFinite)) return null;
  return { symbol, exchange, timeframe, timestamp, open, high, low, close, volume };
}
__name(parseCandle, "parseCandle");
function describeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && "cause" in err ? err.cause : void 0;
  return cause?.code === "ENOTFOUND" || /ENOTFOUND|name could not be resolved/i.test(message) ? "DNS lookup failed" : message;
}
__name(describeError, "describeError");

// ../../packages/core/src/backtest/stats.ts
function computeStats(trades, equityCurve, startingEquity) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let run = 0;
  let runType = "";
  for (const t of trades) {
    const type = t.pnl > 0 ? "W" : "L";
    if (type === runType) {
      run++;
    } else {
      run = 1;
      runType = type;
    }
    if (type === "W" && run > maxConsecutiveWins) maxConsecutiveWins = run;
    if (type === "L" && run > maxConsecutiveLosses) maxConsecutiveLosses = run;
  }
  let maxDrawdown = 0;
  let peak = startingEquity;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak - point.equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const maxDrawdownPct = peak > 0 ? maxDrawdown / peak * 100 : 0;
  const returns = trades.map((t) => t.pnl / startingEquity);
  const meanReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (returns.length - 1) : 0;
  const sharpe = variance > 0 ? meanReturn / Math.sqrt(variance) * Math.sqrt(365) : 0;
  const byMonth = {};
  for (const t of trades) {
    const key = new Date(t.openedAt).toISOString().slice(0, 7);
    byMonth[key] = (byMonth[key] ?? 0) + t.pnl;
  }
  const bySetupType = {};
  const byAsset = {};
  for (const t of trades) {
    const st = bySetupType[t.entryModel] ?? { trades: 0, pnl: 0, winRate: 0 };
    st.trades += 1;
    st.pnl += t.pnl;
    if (t.pnl > 0) st.winRate += 1;
    bySetupType[t.entryModel] = st;
    const as = byAsset[t.symbol] ?? { trades: 0, pnl: 0, winRate: 0 };
    as.trades += 1;
    as.pnl += t.pnl;
    if (t.pnl > 0) as.winRate += 1;
    byAsset[t.symbol] = as;
  }
  for (const key of Object.keys(bySetupType)) {
    bySetupType[key].winRate = bySetupType[key].trades > 0 ? bySetupType[key].winRate / bySetupType[key].trades * 100 : 0;
  }
  for (const key of Object.keys(byAsset)) {
    byAsset[key].winRate = byAsset[key].trades > 0 ? byAsset[key].winRate / byAsset[key].trades * 100 : 0;
  }
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingEquity;
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    netPnl,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: trades.length ? netPnl / trades.length : 0,
    avgTrade: trades.length ? netPnl / trades.length : 0,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    avgRr: trades.length ? trades.reduce((a, t) => a + t.rr, 0) / trades.length : 0,
    avgDurationMs: trades.length ? trades.reduce((a, t) => a + t.durationMs, 0) / trades.length : 0,
    maxDrawdown,
    maxDrawdownPct,
    finalEquity,
    totalReturnPct: startingEquity > 0 ? (finalEquity - startingEquity) / startingEquity * 100 : 0,
    sharpe,
    byMonth,
    bySetupType,
    byAsset
  };
}
__name(computeStats, "computeStats");

// ../../packages/core/src/backtest/engine.ts
async function runBacktest(input, onProgress) {
  const { strategyConfig, riskConfig, marketData, startTime, endTime } = input;
  const ltf = strategyConfig.timeframes.ltf;
  const mtf = strategyConfig.timeframes.mtf;
  const htf = strategyConfig.timeframes.htf;
  const [ltfCandles, mtfCandles, htfCandles] = await Promise.all([
    marketData.getOHLCV(input.symbol, ltf, startTime, endTime, 1e4),
    marketData.getOHLCV(input.symbol, mtf, startTime, endTime, 1e4),
    marketData.getOHLCV(input.symbol, htf, startTime, endTime, 1e4)
  ]);
  ltfCandles.sort((a, b) => a.timestamp - b.timestamp);
  mtfCandles.sort((a, b) => a.timestamp - b.timestamp);
  htfCandles.sort((a, b) => a.timestamp - b.timestamp);
  if (ltfCandles.length === 0) {
    return {
      trades: [],
      equityCurve: [],
      stats: computeStats([], [], input.startingEquity),
      validSetups: 0,
      rejectedSetups: 0,
      message: "No lower-timeframe candles available for the selected range."
    };
  }
  let lastPrice = ltfCandles[0].close;
  const paper = new PaperExecutionAdapter({
    initialBalance: input.startingEquity,
    feePct: riskConfig.feePct,
    slippagePct: riskConfig.slippagePct,
    priceProvider: /* @__PURE__ */ __name((symbol) => symbol === input.symbol ? lastPrice : void 0, "priceProvider")
  });
  const engine = new StrategyEngine({
    strategy: strategyConfig,
    risk: riskConfig,
    mode: "PAPER",
    execution: paper,
    startingEquity: input.startingEquity
  });
  const equityCurve = [];
  const ltfDur = timeframeDuration(ltf);
  let mtfIdx = 0;
  let htfIdx = 0;
  const feedDueHigherTimeframes = /* @__PURE__ */ __name((closeTime) => {
    while (mtfIdx < mtfCandles.length) {
      const c = mtfCandles[mtfIdx];
      if (c.timestamp + timeframeDuration(mtf) <= closeTime) {
        engine.analysis.onCandleClosed(c);
        mtfIdx++;
      } else {
        break;
      }
    }
    while (htfIdx < htfCandles.length) {
      const c = htfCandles[htfIdx];
      if (c.timestamp + timeframeDuration(htf) <= closeTime) {
        engine.analysis.onCandleClosed(c);
        htfIdx++;
      } else {
        break;
      }
    }
  }, "feedDueHigherTimeframes");
  let rejectedCount = 0;
  let validCount = 0;
  for (let i = 0; i < ltfCandles.length; i++) {
    const candle = ltfCandles[i];
    const closeTime = candle.timestamp + ltfDur;
    feedDueHigherTimeframes(closeTime);
    lastPrice = candle.close;
    const cycle = engine.onCandleClosed(candle);
    await engine.flush();
    engine.onPriceBar(input.symbol, candle, closeTime);
    rejectedCount += cycle.rejectedSetups.length;
    validCount += cycle.validSetups.length;
    if (i % 20 === 0 || i === ltfCandles.length - 1) {
      const riskState = engine.getRiskState();
      const unrealized = engine.getOpenPositions().reduce((a, p) => a + p.unrealizedPnl, 0);
      equityCurve.push({
        timestamp: closeTime,
        equity: riskState.equity + unrealized
      });
      onProgress?.({ current: i + 1, total: ltfCandles.length, symbol: input.symbol });
    }
  }
  const trades = engine.getPositions().filter((p) => p.status === "CLOSED").map((p) => {
    const closedEvent = p.events.find((e) => e.type === "CLOSED");
    const exit = closedEvent?.price ?? p.currentPrice;
    const durationMs = closedEvent ? closedEvent.timestamp - p.openedAt : 0;
    const risk = Math.abs(p.entry - p.stopLoss);
    const rr = risk > 0 ? Math.abs(exit - p.entry) / risk : 0;
    return {
      setupId: p.setupId,
      symbol: p.symbol,
      direction: p.direction,
      entry: p.entry,
      exit,
      stopLoss: p.stopLoss,
      takeProfits: p.takeProfits,
      quantity: p.positionSize,
      pnl: p.finalPnl ?? p.realizedPnl,
      rr,
      score: 0,
      entryModel: "CONFIRMATION",
      openedAt: p.openedAt,
      closedAt: closedEvent?.timestamp ?? 0,
      durationMs,
      mae: p.mae,
      mfe: p.mfe,
      closeReason: p.closeReason ?? "closed",
      strategyVersion: p.strategyVersion
    };
  });
  const stats = computeStats(trades, equityCurve, input.startingEquity);
  return {
    trades,
    equityCurve,
    stats,
    validSetups: validCount,
    rejectedSetups: rejectedCount,
    message: `Backtest complete: ${trades.length} closed trades over ${ltfCandles.length} ${ltf} candles.`
  };
}
__name(runBacktest, "runBacktest");

// ../../packages/core/src/analytics/performance.ts
var REJECTED_STATUSES = /* @__PURE__ */ new Set(["REJECTED", "INVALIDATED", "STALE"]);
function closedAtOf(position) {
  if (position.closedAt) return position.closedAt;
  const closeEvent = [...position.events].reverse().find((e) => e.type === "CLOSED");
  return closeEvent?.timestamp ?? position.openedAt;
}
__name(closedAtOf, "closedAtOf");
function realisedRr(position) {
  const riskPerUnit = Math.abs(position.entry - position.stopLoss);
  if (!Number.isFinite(riskPerUnit) || riskPerUnit === 0) return 0;
  const size = position.positionSize || 1;
  const pnl = position.finalPnl ?? position.realizedPnl;
  return pnl / (riskPerUnit * size);
}
__name(realisedRr, "realisedRr");
function positionsToTrades(positions) {
  return positions.filter((position) => position.status === "CLOSED").map((position) => {
    const closedAt = closedAtOf(position);
    return {
      setupId: position.setupId,
      symbol: position.symbol,
      direction: position.direction,
      entry: position.entry,
      exit: position.currentPrice,
      stopLoss: position.stopLoss,
      takeProfits: position.takeProfits,
      quantity: position.positionSize,
      pnl: position.finalPnl ?? position.realizedPnl,
      rr: realisedRr(position),
      score: 0,
      entryModel: position.entryModel ?? "UNSPECIFIED",
      openedAt: position.openedAt,
      closedAt,
      durationMs: Math.max(0, closedAt - position.openedAt),
      mae: position.mae,
      mfe: position.mfe,
      closeReason: position.closeReason ?? "CLOSED",
      strategyVersion: position.strategyVersion
    };
  }).sort((a, b) => a.closedAt - b.closedAt);
}
__name(positionsToTrades, "positionsToTrades");
function summariseRejections(setups) {
  const counts = /* @__PURE__ */ new Map();
  for (const setup of setups) {
    if (!REJECTED_STATUSES.has(setup.status)) continue;
    for (const reason of setup.rejectionReasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
__name(summariseRejections, "summariseRejections");
function computePerformance(input) {
  const trades = positionsToTrades(input.positions);
  const stats = computeStats(trades, input.equityCurve, input.startingEquity);
  const seen = input.setups.length;
  const executed = input.setups.filter((s) => s.status === "EXECUTED").length;
  const valid = input.setups.filter((s) => s.status === "VALID").length;
  const rejected = input.setups.filter((s) => REJECTED_STATUSES.has(s.status)).length;
  return {
    stats,
    funnel: {
      seen,
      valid,
      executed,
      rejected,
      executionRate: seen > 0 ? executed / seen * 100 : 0
    },
    rejectionReasons: summariseRejections(input.setups),
    openPositions: input.positions.filter((p) => p.status === "OPEN").length,
    closedPositions: trades.length,
    startingEquity: input.startingEquity
  };
}
__name(computePerformance, "computePerformance");

// ../../packages/core/src/agents/types.ts
function availableCapital(total, agents) {
  const committed = agents.filter((a) => a.status !== "STOPPED").reduce((sum, a) => sum + a.allocatedCapital, 0);
  return Math.max(0, total - committed);
}
__name(availableCapital, "availableCapital");
function checkAllocation(requested, totalAvailable, existing, excludeAgentId, allAgents) {
  const others = excludeAgentId && allAgents ? allAgents.filter((a) => a.id !== excludeAgentId) : existing;
  const available = availableCapital(totalAvailable, others);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, reason: "Allocated capital must be greater than zero.", available };
  }
  if (requested > available) {
    return {
      ok: false,
      reason: `Only ${available.toFixed(2)} is uncommitted; ${requested.toFixed(2)} was requested. Reduce the amount or free capital from another agent.`,
      available
    };
  }
  return { ok: true, available };
}
__name(checkAllocation, "checkAllocation");

// ../../packages/core/src/agents/regime.ts
function directionalEfficiency(candles) {
  if (candles.length < 3) return 0;
  const net = Math.abs(candles[candles.length - 1].close - candles[0].close);
  let path = 0;
  for (let i = 1; i < candles.length; i++) {
    path += Math.abs(candles[i].close - candles[i - 1].close);
  }
  return path > 0 ? Math.min(1, net / path) : 0;
}
__name(directionalEfficiency, "directionalEfficiency");
var DEFAULT_REGIME_THRESHOLDS = {
  trendEfficiency: 0.28,
  highVolatilityPct: 2.5,
  lowVolatilityPct: 0.35
};
function classifyRegime(candles, structureTrend, thresholds = DEFAULT_REGIME_THRESHOLDS) {
  if (candles.length < 20) {
    return {
      regime: "UNKNOWN",
      confidence: 0,
      volatilityPct: 0,
      efficiency: 0,
      detail: `Only ${candles.length} candles available; at least 20 are needed to classify conditions.`
    };
  }
  const window = candles.slice(-60);
  const atrs = atr(window, 14);
  const lastAtr = atrs[atrs.length - 1];
  const price = window[window.length - 1].close;
  const volatilityPct = Number.isFinite(lastAtr) && price > 0 ? lastAtr / price * 100 : 0;
  const efficiency = directionalEfficiency(window);
  if (volatilityPct >= thresholds.highVolatilityPct) {
    return {
      regime: "VOLATILE",
      confidence: Math.min(1, volatilityPct / (thresholds.highVolatilityPct * 2)),
      volatilityPct,
      efficiency,
      detail: `Average range is ${volatilityPct.toFixed(2)}% of price, above the ${thresholds.highVolatilityPct}% volatile threshold. Stops sized on structure will be wide.`
    };
  }
  if (volatilityPct > 0 && volatilityPct <= thresholds.lowVolatilityPct) {
    return {
      regime: "QUIET",
      confidence: Math.min(1, thresholds.lowVolatilityPct / Math.max(volatilityPct, 0.01) / 3),
      volatilityPct,
      efficiency,
      detail: `Average range is only ${volatilityPct.toFixed(2)}% of price. Moves are small relative to costs.`
    };
  }
  if (efficiency >= thresholds.trendEfficiency && (structureTrend === "BULLISH" || structureTrend === "BEARISH")) {
    return {
      regime: structureTrend === "BULLISH" ? "TRENDING_UP" : "TRENDING_DOWN",
      confidence: Math.min(1, efficiency / (thresholds.trendEfficiency * 2)),
      volatilityPct,
      efficiency,
      detail: `Price is travelling with ${(efficiency * 100).toFixed(0)}% efficiency and structure is ${structureTrend.toLowerCase()}. Continuation setups suit these conditions.`
    };
  }
  return {
    regime: "RANGING",
    confidence: Math.min(1, 1 - efficiency / Math.max(thresholds.trendEfficiency, 0.01)),
    volatilityPct,
    efficiency,
    detail: `Price is retracing most of what it covers (${(efficiency * 100).toFixed(0)}% efficiency). Continuation setups fail more often in these conditions.`
  };
}
__name(classifyRegime, "classifyRegime");

// ../../packages/core/src/agents/supervisor.ts
var DEFAULT_SUPERVISOR_THRESHOLDS = {
  minimumSample: 10,
  poorWinRate: 35,
  losingStreak: 4,
  pauseDrawdownPct: 10,
  poorProfitFactor: 0.9,
  healthyWinRate: 50
};
var ADJUSTMENT_BOUNDS = {
  maxMinRr: 6,
  maxMinScore: 85,
  minRiskPct: 0.1
};
function reviewAgent(performance, current, thresholds = DEFAULT_SUPERVISOR_THRESHOLDS) {
  const adjustments = [];
  const observations = [];
  if (performance.drawdownPct >= thresholds.pauseDrawdownPct) {
    return {
      state: "PAUSED",
      headline: `Paused after a ${performance.drawdownPct.toFixed(1)}% drawdown on allocated capital.`,
      observations: [
        `Drawdown reached ${performance.drawdownPct.toFixed(1)}%, at or beyond the ${thresholds.pauseDrawdownPct}% limit.`,
        "Trading is halted for this agent until it is resumed deliberately."
      ],
      adjustments: []
    };
  }
  if (performance.closedTrades < thresholds.minimumSample) {
    return {
      state: "OBSERVING",
      headline: `Gathering results: ${performance.closedTrades} of ${thresholds.minimumSample} trades needed before judging the analysis.`,
      observations: [
        "Too few closed trades to distinguish a bad approach from ordinary variance."
      ],
      adjustments: []
    };
  }
  let concerns = 0;
  if (performance.consecutiveLosses >= thresholds.losingStreak) {
    concerns++;
    observations.push(
      `${performance.consecutiveLosses} losses in a row. The setups being accepted are not behaving as analysed.`
    );
  }
  if (performance.winRate < thresholds.poorWinRate) {
    concerns++;
    observations.push(
      `Win rate is ${performance.winRate.toFixed(1)}%, below the ${thresholds.poorWinRate}% the analysis needs to justify its reward-to-risk.`
    );
  }
  if (Number.isFinite(performance.profitFactor) && performance.profitFactor < thresholds.poorProfitFactor) {
    concerns++;
    observations.push(
      `Profit factor is ${performance.profitFactor.toFixed(2)}: losses are outweighing wins.`
    );
  }
  if (concerns === 0) {
    const healthy = performance.winRate >= thresholds.healthyWinRate && performance.netPnl > 0;
    return {
      state: healthy ? "HEALTHY" : "OBSERVING",
      headline: healthy ? `Performing as analysed: ${performance.winRate.toFixed(1)}% win rate over ${performance.closedTrades} trades.` : `Within tolerance over ${performance.closedTrades} trades. No change required.`,
      observations: observations.length ? observations : ["Results are consistent with the analysis."],
      adjustments: []
    };
  }
  const nextMinRr = Math.min(ADJUSTMENT_BOUNDS.maxMinRr, round1(current.minRr + 0.5 * concerns));
  const nextMinScore = Math.min(ADJUSTMENT_BOUNDS.maxMinScore, Math.round(current.minScore + 5 * concerns));
  const nextRisk = Math.max(ADJUSTMENT_BOUNDS.minRiskPct, round2(current.riskPerTrade * (concerns >= 2 ? 0.5 : 0.75)));
  if (nextMinRr > current.minRr) {
    adjustments.push({
      field: "minRr",
      from: current.minRr,
      to: nextMinRr,
      reason: "Demand more reward for the same risk before accepting a setup."
    });
  }
  if (nextMinScore > current.minScore) {
    adjustments.push({
      field: "minScore",
      from: current.minScore,
      to: nextMinScore,
      reason: "Accept only higher-quality setups until results recover."
    });
  }
  if (nextRisk < current.riskPerTrade) {
    adjustments.push({
      field: "riskPerTrade",
      from: current.riskPerTrade,
      to: nextRisk,
      reason: "Reduce the cost of each trade while the analysis is underperforming."
    });
  }
  return {
    state: "TIGHTENING",
    headline: `${concerns} performance ${concerns === 1 ? "concern" : "concerns"} found. The agent is being made more selective.`,
    observations,
    adjustments
  };
}
__name(reviewAgent, "reviewAgent");
function relaxAgent(performance, current, baseline, thresholds = DEFAULT_SUPERVISOR_THRESHOLDS) {
  if (performance.closedTrades < thresholds.minimumSample) return [];
  if (performance.winRate < thresholds.healthyWinRate || performance.netPnl <= 0) return [];
  const adjustments = [];
  if (current.minRr > baseline.minRr) {
    adjustments.push({
      field: "minRr",
      from: current.minRr,
      to: round1(Math.max(baseline.minRr, current.minRr - 0.5)),
      reason: "Results recovered; returning towards the configured reward-to-risk."
    });
  }
  if (current.minScore > baseline.minScore) {
    adjustments.push({
      field: "minScore",
      from: current.minScore,
      to: Math.max(baseline.minScore, current.minScore - 5),
      reason: "Results recovered; widening the quality filter back towards its baseline."
    });
  }
  if (current.riskPerTrade < baseline.riskPerTrade) {
    adjustments.push({
      field: "riskPerTrade",
      from: current.riskPerTrade,
      to: round2(Math.min(baseline.riskPerTrade, current.riskPerTrade * 1.5)),
      reason: "Results recovered; restoring risk towards the configured level."
    });
  }
  return adjustments;
}
__name(relaxAgent, "relaxAgent");
function round1(n) {
  return Math.round(n * 10) / 10;
}
__name(round1, "round1");
function round2(n) {
  return Math.round(n * 100) / 100;
}
__name(round2, "round2");

// src/runtime.ts
var CANDLE_BUFFER = 240;
var HYDRATION_BUDGET = 800;
var WARMING_TICK_MS = 2e4;
var SNAPSHOT_HEARTBEAT_MS = 10 * 6e4;
var STEADY_TICK_MS = 5 * 6e4;
function candleKey(symbol, tf) {
  return `candles:${symbol}:${tf}`;
}
__name(candleKey, "candleKey");
function snapshotKey(symbol, namespace) {
  return namespace ? `engine:${namespace}:${symbol}` : `engine:${symbol}`;
}
__name(snapshotKey, "snapshotKey");
function mergeCandles(stored, incoming) {
  const byTimestamp = /* @__PURE__ */ new Map();
  for (const candle of stored) byTimestamp.set(candle.timestamp, candle);
  for (const candle of incoming) byTimestamp.set(candle.timestamp, candle);
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-CANDLE_BUFFER);
}
__name(mergeCandles, "mergeCandles");
function closedCandlesOnly(candles, tfDurationMs, now) {
  return candles.filter((candle) => candle.timestamp + tfDurationMs <= now);
}
__name(closedCandlesOnly, "closedCandlesOnly");
var TF_MS = TIMEFRAME_DURATION_MS;
var TradingRuntime = class {
  static {
    __name(this, "TradingRuntime");
  }
  storage;
  marketData;
  symbols = /* @__PURE__ */ new Map();
  lastProvider = "unknown";
  hydrationBudget;
  /**
   * Scopes engine state to one owner. Candle buffers are deliberately left
   * unscoped: market data is the same for everyone, so agents share it rather
   * than each storing their own copy of the same bars.
   */
  namespace;
  constructor(storage, opts = {}) {
    this.storage = storage;
    this.hydrationBudget = opts.hydrationBudget ?? HYDRATION_BUDGET;
    this.namespace = opts.namespace ?? "";
    this.marketData = new MultiExchangeMarketData({
      fetchFn: opts.fetchFn,
      timeoutMs: 8e3
    });
  }
  get provider() {
    return this.lastProvider;
  }
  strategyConfigFor(symbol, overrides) {
    return {
      ...DEFAULT_STRATEGY_CONFIG,
      ...overrides,
      symbol,
      exchange: "multi-exchange"
    };
  }
  /** Read the stored candle buffers without contacting an exchange. */
  async storedBuffers(symbol, timeframes, now) {
    const unique = [.../* @__PURE__ */ new Set([timeframes.htf, timeframes.mtf, timeframes.ltf])];
    const buffers = {};
    for (const tf of unique) {
      const stored = await this.storage.get(candleKey(symbol, tf)) ?? [];
      buffers[tf] = closedCandlesOnly(stored, TF_MS[tf], now);
    }
    return buffers;
  }
  /**
   * Fetch new candles for every configured timeframe and persist them. Returns
   * the merged, stored buffers so a caller can replay them into the engine.
   */
  async refreshCandles(symbol, timeframes, now) {
    const unique = [.../* @__PURE__ */ new Set([timeframes.htf, timeframes.mtf, timeframes.ltf])];
    const buffers = {};
    const writes = {};
    for (const tf of unique) {
      const stored = await this.storage.get(candleKey(symbol, tf)) ?? [];
      const newestStored = stored.at(-1)?.timestamp ?? 0;
      const span = TF_MS[tf] * CANDLE_BUFFER;
      const startTime = newestStored > 0 ? newestStored : now - span;
      let fetched = [];
      try {
        fetched = await this.marketData.getOHLCV(symbol, tf, startTime, now, CANDLE_BUFFER);
        this.lastProvider = fetched[0]?.exchange ?? this.lastProvider;
      } catch (error) {
        if (!stored.length) throw error;
      }
      const merged = mergeCandles(stored, fetched);
      buffers[tf] = closedCandlesOnly(merged, TF_MS[tf], now);
      const changed = merged.length !== stored.length || merged.at(-1)?.timestamp !== stored.at(-1)?.timestamp || merged.at(-1)?.close !== stored.at(-1)?.close;
      if (changed) writes[candleKey(symbol, tf)] = merged;
    }
    if (Object.keys(writes).length > 0) await this.storage.put(writes);
    return buffers;
  }
  /**
   * Run one analysis tick for a symbol. Creates the engine if needed, replays
   * any outstanding history within the hydration budget, feeds new candles and
   * returns the resulting analysis.
   */
  async tick(symbol, opts) {
    const now = opts.now ?? Date.now();
    const strategyCfg = this.strategyConfigFor(symbol, opts.strategy);
    const riskCfg = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, ...opts.risk });
    let state = this.symbols.get(symbol);
    if (!state) {
      const engine2 = new StrategyEngine({
        strategy: strategyCfg,
        risk: riskCfg,
        mode: opts.mode,
        startingEquity: opts.startingEquity,
        analysis: new AnalysisEngine(symbol, "multi-exchange", strategyCfg)
      });
      const stored = await this.storage.get(snapshotKey(symbol, this.namespace));
      const persisted = stored ? "snapshot" in stored ? stored : { snapshot: stored } : void 0;
      if (persisted?.snapshot) {
        try {
          engine2.restore(persisted.snapshot);
        } catch {
        }
      }
      state = { engine: engine2, fedThrough: {}, warm: false };
      this.symbols.set(symbol, state);
    }
    const engine = state.engine;
    engine.setMode(opts.mode);
    engine.updateRiskConfig(riskCfg);
    if (engine.isAutoTrading() !== opts.autoTrading) engine.setAutoTrading(opts.autoTrading);
    if (opts.safetyBlocked && !engine.isSafetyBlocked()) engine.enterSafeMode("Safety stop is engaged.");
    if (!opts.safetyBlocked && engine.isSafetyBlocked()) engine.exitSafeMode();
    const backlogOf = /* @__PURE__ */ __name((buffers2) => Object.values(buffers2).flat().filter((candle) => candle.timestamp > (state.fedThrough[candle.timeframe] ?? 0)).sort((a, b) => a.timestamp - b.timestamp), "backlogOf");
    let buffers = await this.storedBuffers(symbol, strategyCfg.timeframes, now);
    let usedStoredHistory = true;
    if (backlogOf(buffers).length < this.hydrationBudget) {
      buffers = await this.refreshCandles(symbol, strategyCfg.timeframes, now);
      usedStoredHistory = false;
    }
    const pending = backlogOf(buffers);
    const budgeted = pending.slice(0, this.hydrationBudget);
    const warming = budgeted.length < pending.length;
    let executed = 0;
    let rejected = 0;
    let message;
    const blocked = /* @__PURE__ */ new Set();
    for (const candle of budgeted) {
      const result = engine.onCandleClosed(candle);
      state.fedThrough[candle.timeframe] = candle.timestamp;
      executed += result.decisions.filter((d) => d.decision === "EXECUTE").length;
      rejected += result.rejectedSetups.length;
      for (const decision of result.decisions) {
        if (decision.decision === "REJECT") for (const reason of decision.reasons) blocked.add(reason);
      }
      message = result.message ?? message;
    }
    const ltfBuffer = buffers[strategyCfg.timeframes.ltf] ?? [];
    const lastBar = ltfBuffer.at(-1);
    if (budgeted.length === 0 && lastBar) {
      const result = engine.reevaluate(lastBar.close);
      executed += result.decisions.filter((d) => d.decision === "EXECUTE").length;
      rejected += result.rejectedSetups.length;
      for (const decision of result.decisions) {
        if (decision.decision === "REJECT") for (const reason of decision.reasons) blocked.add(reason);
      }
      message = result.message ?? message;
    }
    await engine.flush();
    if (lastBar) engine.onPriceBar(symbol, lastBar, lastBar.timestamp);
    state.warm = !warming && pending.length === budgeted.length;
    const analysis = engine.analysis.analyze();
    await this.persist(symbol, engine);
    return {
      symbol,
      exchange: this.lastProvider,
      status: warming ? "WARMING_UP" : analysis.status,
      warming,
      nextTickMs: warming ? WARMING_TICK_MS : STEADY_TICK_MS,
      usedStoredHistory,
      analysis,
      executed,
      rejected,
      blockedReasons: [...blocked].slice(-6),
      message: warming ? `Replaying stored history: ${pending.length - budgeted.length} candles remaining before analysis is authoritative.` : message
    };
  }
  /**
   * Snapshots exist so an evicted Durable Object can resume without losing
   * positions or the audit trail. They are large, so they are written when that
   * state changes and otherwise at a slow heartbeat, rather than every tick.
   */
  async persist(symbol, engine) {
    const snapshot = engine.serialize();
    const signature = [
      snapshot.positions.length,
      snapshot.journal.length,
      snapshot.activity.length,
      snapshot.risk.equity.toFixed(6),
      snapshot.risk.tradesToday
    ].join(":");
    const state = this.symbols.get(symbol);
    const now = Date.now();
    const due = !state?.lastPersistAt || now - state.lastPersistAt >= SNAPSHOT_HEARTBEAT_MS;
    if (state && signature === state.lastSnapshotSignature && !due) return;
    if (state) {
      state.lastSnapshotSignature = signature;
      state.lastPersistAt = now;
    }
    const payload = { snapshot };
    await this.storage.put({ [snapshotKey(symbol, this.namespace)]: payload });
  }
  engineFor(symbol) {
    return this.symbols.get(symbol)?.engine;
  }
};

// src/ingest.ts
var TOKEN_TTL_MS = 6e4;
function toBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(toBase64Url, "toBase64Url");
async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(digest);
}
__name(sha256Base64Url, "sha256Base64Url");
async function signIngestBody(body, secret, now = Date.now()) {
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({
      sub: "worker",
      exp: now + TOKEN_TTL_MS,
      bodyHash: await sha256Base64Url(body)
    }))
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(signature)}`;
}
__name(signIngestBody, "signIngestBody");
function toDecisionRecord(setup) {
  return {
    setupId: setup.id,
    symbol: setup.symbol,
    exchange: setup.exchange,
    direction: setup.direction,
    entryModel: setup.entryModel,
    timeframe: setup.timeframe,
    status: setup.status,
    score: setup.score,
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    stopLossReason: setup.stopLossReason,
    takeProfits: setup.takeProfits,
    takeProfitReasons: setup.takeProfitReasons,
    rr: setup.rr,
    counterTrend: setup.counterTrend,
    hardRules: setup.hardRules,
    factors: setup.factors,
    qualityFactors: setup.qualityFactors,
    reasons: setup.reasons,
    rejectionReasons: setup.rejectionReasons,
    strategyVersion: setup.strategyVersion,
    createdAt: setup.createdAt
  };
}
__name(toDecisionRecord, "toDecisionRecord");
async function sendIngest(config, batch) {
  const candles = batch.candles.length;
  const setups = batch.setups.length;
  if (!config?.url || !config.secret) {
    return { sent: false, reason: "Durable storage is not configured.", candles: 0, setups: 0 };
  }
  if (!candles && !setups && !batch.run) {
    return { sent: false, reason: "Nothing new to persist.", candles: 0, setups: 0 };
  }
  const body = JSON.stringify({
    userId: batch.userId,
    candles: batch.candles,
    setups: batch.setups.map(toDecisionRecord),
    run: batch.run
  });
  try {
    const token = await signIngestBody(body, config.secret);
    const doFetch = config.fetchFn ?? fetch;
    const response = await doFetch(`${config.url.replace(/\/$/, "")}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(8e3)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { sent: false, reason: `Ingest returned ${response.status}. ${detail}`.trim(), candles: 0, setups: 0 };
    }
    return { sent: true, candles, setups };
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof Error ? error.message : "Ingest request failed.",
      candles: 0,
      setups: 0
    };
  }
}
__name(sendIngest, "sendIngest");

// src/agents.ts
var SYMBOL_BUDGET_PER_TICK = 6;
function agentKey(id) {
  return `agent:${id}`;
}
__name(agentKey, "agentKey");
function defaultAgentConfig(input) {
  const baseline = {
    riskPerTrade: input.riskPerTrade ?? DEFAULT_RISK_CONFIG.riskPerTrade,
    minRr: input.minRr ?? DEFAULT_STRATEGY_CONFIG.minRr,
    minScore: input.minScore ?? 60
  };
  const now = Date.now();
  return {
    id: input.id,
    name: input.name,
    mode: input.mode,
    allocatedCapital: input.allocatedCapital,
    symbols: input.symbols,
    timeframes: DEFAULT_STRATEGY_CONFIG.timeframes,
    entryModels: input.entryModels ?? ["CONFIRMATION", "SWEEP"],
    baseline,
    // Working values start at the baseline and only the supervisor moves them.
    working: { ...baseline },
    requiredRegimes: input.requiredRegimes ?? [],
    maxOpenPositions: DEFAULT_RISK_CONFIG.maxOpenPositions,
    maxDailyLossPct: DEFAULT_RISK_CONFIG.maxDailyLossPct,
    maxDrawdownPct: DEFAULT_SUPERVISOR_THRESHOLDS.pauseDrawdownPct,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now
  };
}
__name(defaultAgentConfig, "defaultAgentConfig");
var AgentRuntime = class {
  static {
    __name(this, "AgentRuntime");
  }
  storage;
  runtimes = /* @__PURE__ */ new Map();
  fetchFn;
  /** Rotates which symbols are analysed when more exist than the budget allows. */
  cursor = 0;
  constructor(storage, opts = {}) {
    this.storage = storage;
    this.fetchFn = opts.fetchFn;
  }
  async list() {
    return await this.storage.get("agents") ?? [];
  }
  async save(agents) {
    await this.storage.put({ agents });
  }
  async create(input, totalCapital) {
    const agents = await this.list();
    if (agents.length >= 20) return { error: "An account is limited to 20 agents." };
    if (!input.symbols.length) return { error: "An agent needs at least one market." };
    const check = checkAllocation(input.allocatedCapital, totalCapital, agents);
    if (!check.ok) return { error: check.reason };
    const agent = defaultAgentConfig(input);
    await this.save([...agents, agent]);
    return { agent };
  }
  async update(id, patch, totalCapital) {
    const agents = await this.list();
    const existing = agents.find((a) => a.id === id);
    if (!existing) return { error: "No agent with that id." };
    if (patch.allocatedCapital !== void 0) {
      const check = checkAllocation(patch.allocatedCapital, totalCapital, [], id, agents);
      if (!check.ok) return { error: check.reason };
    }
    const updated = {
      ...existing,
      ...patch,
      // Resuming a supervisor-paused agent restores its baseline settings, so a
      // deliberate restart is not silently crippled by earlier tightening.
      working: patch.status === "ACTIVE" && existing.status === "SUPERVISOR_PAUSED" ? { ...existing.baseline } : existing.working,
      updatedAt: Date.now()
    };
    await this.save(agents.map((a) => a.id === id ? updated : a));
    return { agent: updated };
  }
  async remove(id) {
    const agents = await this.list();
    if (!agents.some((a) => a.id === id)) return false;
    await this.save(agents.filter((a) => a.id !== id));
    return true;
  }
  runtimeFor(agent) {
    let runtime = this.runtimes.get(agent.id);
    if (!runtime) {
      runtime = new TradingRuntime(this.storage, {
        fetchFn: this.fetchFn,
        namespace: agent.id
      });
      this.runtimes.set(agent.id, runtime);
    }
    return runtime;
  }
  /** Every closed and open position the agent's engines are holding. */
  positionsOf(agent) {
    const runtime = this.runtimes.get(agent.id);
    if (!runtime) return [];
    return agent.symbols.flatMap((symbol) => runtime.engineFor(symbol)?.getPositions() ?? []);
  }
  setupsOf(agent) {
    const runtime = this.runtimes.get(agent.id);
    if (!runtime) return [];
    return agent.symbols.flatMap((symbol) => {
      const engine = runtime.engineFor(symbol);
      return engine ? engine.analysis.analyze().setups : [];
    });
  }
  /**
   * Realised performance for one agent, measured against its own allocation
   * rather than a global account balance.
   */
  performanceOf(agent) {
    const positions = this.positionsOf(agent);
    const closed = positions.filter((p) => p.status === "CLOSED");
    const wins = closed.filter((p) => (p.finalPnl ?? p.realizedPnl) > 0).length;
    const netPnl = closed.reduce((sum, p) => sum + (p.finalPnl ?? p.realizedPnl), 0);
    const performance = computePerformance({
      positions,
      setups: this.setupsOf(agent),
      equityCurve: [],
      startingEquity: agent.allocatedCapital
    });
    const byClose = [...closed].sort(
      (a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt)
    );
    let consecutiveLosses = 0;
    for (const position of byClose) {
      if ((position.finalPnl ?? position.realizedPnl) > 0) break;
      consecutiveLosses++;
    }
    const equity = agent.allocatedCapital + netPnl;
    const peak = Math.max(agent.allocatedCapital, equity);
    const drawdownPct = peak > 0 ? Math.max(0, (peak - equity) / peak * 100) : 0;
    return {
      closedTrades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? wins / closed.length * 100 : 0,
      netPnl,
      profitFactor: performance.stats.profitFactor,
      consecutiveLosses,
      drawdownPct,
      equity,
      openPositions: positions.filter((p) => p.status === "OPEN").length
    };
  }
  /**
   * Run one pass over every active agent. Symbols are rotated so a large number
   * of agents cannot put unbounded work into a single invocation.
   */
  async tickAll(now = Date.now()) {
    const agents = await this.list();
    const active = agents.filter((a) => a.status === "ACTIVE");
    const results = [];
    const work = active.flatMap(
      (agent) => agent.symbols.map((symbol) => ({ agent, symbol }))
    );
    if (work.length === 0) return results;
    const slice = [];
    for (let i = 0; i < Math.min(SYMBOL_BUDGET_PER_TICK, work.length); i++) {
      slice.push(work[(this.cursor + i) % work.length]);
    }
    this.cursor = (this.cursor + slice.length) % work.length;
    const byAgent = /* @__PURE__ */ new Map();
    for (const item of slice) {
      byAgent.set(item.agent.id, [...byAgent.get(item.agent.id) ?? [], item.symbol]);
    }
    let mutated = false;
    const next = [...agents];
    for (const agent of active) {
      const symbols = byAgent.get(agent.id);
      if (!symbols?.length) continue;
      const runtime = this.runtimeFor(agent);
      const ticks = [];
      const regimes = {};
      for (const symbol of symbols) {
        try {
          const tick = await runtime.tick(symbol, {
            mode: agent.mode === "LIVE" ? "LIVE" : "PAPER",
            risk: {
              ...DEFAULT_RISK_CONFIG,
              riskPerTrade: agent.working.riskPerTrade,
              maxOpenPositions: agent.maxOpenPositions,
              maxDailyLossPct: agent.maxDailyLossPct,
              maxDrawdownPct: agent.maxDrawdownPct
            },
            strategy: {
              minRr: agent.working.minRr,
              entryModels: {
                aggressive: agent.entryModels.includes("AGGRESSIVE"),
                confirmation: agent.entryModels.includes("CONFIRMATION"),
                sweep: agent.entryModels.includes("SWEEP"),
                counterTrend: agent.entryModels.includes("COUNTER_TREND")
              }
            },
            autoTrading: true,
            safetyBlocked: false,
            startingEquity: agent.allocatedCapital,
            now
          });
          ticks.push(tick);
          const ltf = agent.timeframes.ltf;
          const snapshot = tick.analysis.snapshots[ltf];
          if (snapshot) {
            regimes[symbol] = classifyRegime(snapshot.candles, snapshot.structure.trend);
          }
        } catch (error) {
          console.warn(JSON.stringify({
            event: "agent_symbol_failed",
            agent: agent.name,
            symbol,
            reason: error instanceof Error ? error.message : String(error),
            timestamp: now
          }));
        }
      }
      const performance = this.performanceOf(agent);
      const verdict = reviewAgent(performance, agent.working);
      const applied = [];
      if (verdict.state === "PAUSED") {
        const index = next.findIndex((a) => a.id === agent.id);
        if (index >= 0) {
          next[index] = { ...next[index], status: "SUPERVISOR_PAUSED", updatedAt: now };
          mutated = true;
        }
      } else if (verdict.adjustments.length) {
        applied.push(...verdict.adjustments);
      } else {
        applied.push(...relaxAgent(performance, agent.working, agent.baseline));
      }
      if (applied.length) {
        const index = next.findIndex((a) => a.id === agent.id);
        if (index >= 0) {
          const working = { ...next[index].working };
          for (const adjustment of applied) working[adjustment.field] = adjustment.to;
          next[index] = { ...next[index], working, updatedAt: now };
          mutated = true;
        }
        const history = await this.storage.get(agentKey(agent.id)) ?? [];
        await this.storage.put({
          [agentKey(agent.id)]: [...applied.map((a) => ({ ...a, at: now })), ...history].slice(0, 50)
        });
      }
      results.push({
        agentId: agent.id,
        name: agent.name,
        ticks,
        performance,
        supervisor: verdict,
        applied,
        regimes
      });
    }
    if (mutated) await this.save(next);
    return results;
  }
  /** Everything the agents view needs, without the chart-sized payloads. */
  async snapshots() {
    const agents = await this.list();
    const out = [];
    for (const agent of agents) {
      const performance = this.performanceOf(agent);
      out.push({
        config: agent,
        performance,
        supervisor: reviewAgent(performance, agent.working),
        adjustmentHistory: await this.storage.get(agentKey(agent.id)) ?? []
      });
    }
    return out;
  }
  /** Closed and open positions across every agent, newest first. */
  async trades() {
    const agents = await this.list();
    return agents.flatMap(
      (agent) => this.positionsOf(agent).map((position) => ({
        ...position,
        agentId: agent.id,
        agentName: agent.name
      }))
    ).sort((a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt));
  }
  engineRuntimeFor(agentId) {
    return this.runtimes.get(agentId);
  }
};

// src/news.ts
var FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" }
];
var NEGATIVE = [
  "hack",
  "exploit",
  "breach",
  "lawsuit",
  "sue",
  "ban",
  "crackdown",
  "collapse",
  "bankrupt",
  "insolvent",
  "liquidation",
  "crash",
  "plunge",
  "sell-off",
  "selloff",
  "fraud",
  "investigation",
  "delist",
  "outage",
  "halt",
  "sanction"
];
var POSITIVE = [
  "approval",
  "approved",
  "etf",
  "adoption",
  "partnership",
  "upgrade",
  "rally",
  "surge",
  "record high",
  "inflow",
  "institutional",
  "listing",
  "integration"
];
var SYMBOL_WORDS = {
  BTCUSDT: ["bitcoin", "btc"],
  ETHUSDT: ["ethereum", "ether", "eth"],
  SOLUSDT: ["solana", "sol"],
  XRPUSDT: ["ripple", "xrp"],
  BNBUSDT: ["binance coin", "bnb"],
  ADAUSDT: ["cardano", "ada"],
  DOGEUSDT: ["dogecoin", "doge"],
  LINKUSDT: ["chainlink", "link"]
};
function classifySentiment(title) {
  const lower = title.toLowerCase();
  const negative = NEGATIVE.some((word) => lower.includes(word));
  const positive = POSITIVE.some((word) => lower.includes(word));
  if (negative) return "NEGATIVE";
  if (positive) return "POSITIVE";
  return "NEUTRAL";
}
__name(classifySentiment, "classifySentiment");
function symbolsMentioned(title, universe) {
  const lower = title.toLowerCase();
  return universe.filter((symbol) => {
    const words = SYMBOL_WORDS[symbol] ?? [symbol.replace(/USDT$/, "").toLowerCase()];
    return words.some((word) => new RegExp(`\\b${word}\\b`).test(lower));
  });
}
__name(symbolsMentioned, "symbolsMentioned");
function parseRss(xml, source, universe) {
  const items = [];
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
      sentiment: classifySentiment(title)
    });
  }
  return items;
}
__name(parseRss, "parseRss");
function pick(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return "";
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}
__name(pick, "pick");
function decodeXml(value) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim();
}
__name(decodeXml, "decodeXml");
async function fetchNews(universe, opts = {}) {
  const doFetch = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const sources = [];
  const items = [];
  for (const feed of FEEDS) {
    try {
      const response = await doFetch(feed.url, { signal: AbortSignal.timeout(6e3) });
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
        detail: error instanceof Error ? error.message : "request failed"
      });
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const deduped = items.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, opts.limit ?? 40);
  return {
    items: deduped,
    fetchedAt: Date.now(),
    sources,
    unavailable: sources.every((s) => !s.ok)
  };
}
__name(fetchNews, "fetchNews");

// src/index.ts
var JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
var DEFAULT_ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
var { correlationGroups: _correlationGroups, ...DEFAULT_RISK } = DEFAULT_RISK_CONFIG;
var STARTING_EQUITY = 1e4;
var MAX_BACKTEST_CANDLES = 4e3;
function corsHeaders(request, env) {
  const headers = new Headers(JSON_HEADERS);
  const origin = request.headers.get("origin");
  if (origin && (!env.ALLOWED_ORIGIN || origin === env.ALLOWED_ORIGIN)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  return headers;
}
__name(corsHeaders, "corsHeaders");
function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request, env) });
}
__name(json, "json");
async function authenticatedUser(request, env) {
  let value = request.headers.get("authorization");
  if (!value) {
    const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((item) => item.trim()) ?? [];
    const protocolToken = protocols.find((item) => item.includes("."));
    if (protocolToken) value = `Bearer ${protocolToken}`;
  }
  if (!env.WORKER_AUTH_SECRET || !value?.startsWith("Bearer ")) return void 0;
  const [payload, signature] = value.slice(7).split(".");
  if (!payload || !signature) return void 0;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WORKER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), new TextEncoder().encode(payload));
  if (!valid) return void 0;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims.sub === "string" && typeof claims.exp === "number" && claims.exp > Date.now() ? claims.sub : void 0;
  } catch {
    return void 0;
  }
}
__name(authenticatedUser, "authenticatedUser");
function baseState(mode, assets) {
  return {
    symbol: assets[0] ?? "BTCUSDT",
    exchange: "multi-exchange",
    marketDataSource: "worker-starter",
    timeframes: { htf: "4h", mtf: "1h", ltf: "15m" },
    mode,
    autoTrading: false,
    safetyBlocked: false,
    strategyVersion: "cloudflare-paper-v1",
    dayKey: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    feed: { running: true, candlesFed: 0, cyclesProcessed: 0, lastPollAt: null, lastPollCandles: 0, lastError: null, consecutiveErrors: 0, safeModeTriggered: false, perTimeframe: {} }
  };
}
__name(baseState, "baseState");
function serializeAnalysis(tick) {
  const { analysis } = tick;
  return {
    symbol: analysis.symbol,
    exchange: tick.exchange,
    bias: analysis.bias,
    status: tick.status,
    warming: tick.warming,
    // Prefer the engine's own account of why nothing is tradeable.
    message: tick.message ?? analysis.noTradeReason ?? null,
    noTradeReason: analysis.noTradeReason ?? null,
    topDown: analysis.topDown,
    setups: analysis.setups,
    events: analysis.events.map((event) => ({
      type: event.type,
      description: event.detail,
      timestamp: event.timestamp
    })),
    updatedAt: analysis.updatedAt
  };
}
__name(serializeAnalysis, "serializeAnalysis");
function lastCloseOf(tick) {
  const timeframes = Object.values(tick.analysis.snapshots);
  for (const snapshot of timeframes.reverse()) {
    const close = snapshot?.candles.at(-1)?.close;
    if (Number.isFinite(close)) return close;
  }
  return null;
}
__name(lastCloseOf, "lastCloseOf");
var TradingSession = class extends DurableObject {
  static {
    __name(this, "TradingSession");
  }
  runtimeInstance;
  /** Guards against rewriting unchanged engine output every tick. */
  lastEngineSignature = "";
  lastAnyWarming;
  agentRuntimeInstance;
  /** Agents are held on the instance so their engines stay warm between ticks. */
  agents() {
    if (!this.agentRuntimeInstance) {
      this.agentRuntimeInstance = new AgentRuntime({
        get: /* @__PURE__ */ __name((key) => this.ctx.storage.get(key), "get"),
        put: /* @__PURE__ */ __name((entries) => this.ctx.storage.put(entries), "put")
      });
    }
    return this.agentRuntimeInstance;
  }
  // ---- agents ------------------------------------------------------------
  async listAgents() {
    const snapshots = await this.agents().snapshots();
    const committed = snapshots.filter((s) => s.config.status !== "STOPPED").reduce((sum, s) => sum + s.config.allocatedCapital, 0);
    return {
      agents: snapshots,
      capital: { total: await this.totalCapital(), committed }
    };
  }
  /**
   * Capital an operator may allocate. Paper capital is whatever they nominate;
   * live capital would come from the exchange balance, which is not connected,
   * so it is reported as zero rather than invented.
   */
  async totalCapital() {
    return await this.ctx.storage.get("paperCapital") ?? STARTING_EQUITY;
  }
  async setPaperCapital(amount) {
    const total = Math.max(0, amount);
    await this.ctx.storage.put({ paperCapital: total });
    return { total };
  }
  async createAgent(input) {
    const symbols = Array.isArray(input.symbols) ? input.symbols.map((s) => String(s).toUpperCase().replace("/", "")) : [];
    const result = await this.agents().create(
      {
        id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: String(input.name ?? "Agent").slice(0, 60),
        mode: input.mode === "LIVE" ? "LIVE" : "PAPER",
        allocatedCapital: Number(input.allocatedCapital),
        symbols,
        entryModels: Array.isArray(input.entryModels) ? input.entryModels : void 0,
        riskPerTrade: input.riskPerTrade === void 0 ? void 0 : Number(input.riskPerTrade),
        minRr: input.minRr === void 0 ? void 0 : Number(input.minRr),
        requiredRegimes: Array.isArray(input.requiredRegimes) ? input.requiredRegimes : void 0
      },
      await this.totalCapital()
    );
    if (result.error) return { error: result.error };
    await this.ensureAnalysisAlarm();
    return { agent: result.agent };
  }
  async updateAgent(id, patch) {
    const result = await this.agents().update(id, patch, await this.totalCapital());
    return result.error ? { error: result.error } : { agent: result.agent };
  }
  async deleteAgent(id) {
    return { removed: await this.agents().remove(id) };
  }
  async agentTrades() {
    return { trades: await this.agents().trades() };
  }
  /** Portfolio across every agent: what is committed, held and realised. */
  async portfolio() {
    const snapshots = await this.agents().snapshots();
    const total = await this.totalCapital();
    const committed = snapshots.filter((s) => s.config.status !== "STOPPED").reduce((sum, s) => sum + s.config.allocatedCapital, 0);
    const equity = snapshots.reduce((sum, s) => sum + s.performance.equity, 0);
    const realised = snapshots.reduce((sum, s) => sum + s.performance.netPnl, 0);
    const openPositions = snapshots.reduce((sum, s) => sum + s.performance.openPositions, 0);
    const closedTrades = snapshots.reduce((sum, s) => sum + s.performance.closedTrades, 0);
    const wins = snapshots.reduce((sum, s) => sum + s.performance.wins, 0);
    return {
      totalCapital: total,
      committed,
      uncommitted: Math.max(0, total - committed),
      equity: equity + Math.max(0, total - committed),
      realisedPnl: realised,
      openPositions,
      closedTrades,
      winRate: closedTrades ? wins / closedTrades * 100 : 0,
      agents: snapshots.map((s) => ({
        id: s.config.id,
        name: s.config.name,
        mode: s.config.mode,
        status: s.config.status,
        allocated: s.config.allocatedCapital,
        equity: s.performance.equity,
        netPnl: s.performance.netPnl,
        openPositions: s.performance.openPositions
      })),
      updatedAt: Date.now()
    };
  }
  /**
   * Tradeable markets, from the exchanges the engine actually reads. Cached for
   * a day because the list changes rarely and the call is heavy. A failed
   * refresh keeps the previous list rather than emptying the picker.
   */
  async availableMarkets() {
    const cached = await this.ctx.storage.get("markets");
    if (cached && Date.now() - cached.fetchedAt < 864e5) return cached;
    try {
      const symbols = await new MultiExchangeMarketData({ timeoutMs: 1e4 }).getMarkets();
      const usdt = symbols.filter((symbol) => symbol.endsWith("USDT")).sort((a, b) => a.localeCompare(b));
      const fresh = { symbols: usdt, fetchedAt: Date.now() };
      await this.ctx.storage.put({ markets: fresh });
      return fresh;
    } catch (error) {
      if (cached) return cached;
      return {
        symbols: [],
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : "Market list unavailable."
      };
    }
  }
  async marketConditions() {
    return await this.ctx.storage.get("marketConditions") ?? {
      conditions: [],
      updatedAt: null
    };
  }
  /** Cached so the feeds are polled on the analysis cadence, not per request. */
  async news() {
    const cached = await this.ctx.storage.get("news");
    if (cached && Date.now() - cached.fetchedAt < 15 * 6e4) return cached;
    const assets = await this.getAssets();
    const fresh = await fetchNews(assets);
    if (fresh.unavailable && cached) return cached;
    await this.ctx.storage.put({ news: fresh });
    return fresh;
  }
  /**
   * The runtime is held on the Durable Object instance so engines stay warm
   * between ticks. After an eviction it rebuilds itself from stored candles and
   * the persisted engine snapshot.
   */
  runtime() {
    if (!this.runtimeInstance) {
      const storage = {
        get: /* @__PURE__ */ __name((key) => this.ctx.storage.get(key), "get"),
        put: /* @__PURE__ */ __name((entries) => this.ctx.storage.put(entries), "put")
      };
      this.runtimeInstance = new TradingRuntime(storage);
    }
    return this.runtimeInstance;
  }
  async fetch(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "state", payload: await this.getStreamState() }));
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "smc-v1" } });
  }
  async webSocketMessage(socket, message) {
    if (message === "ping") socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
  }
  async getStreamState() {
    const [mode, assets, positions, risk, journal, activity, config, autoTrading, safetyBlocked] = await Promise.all([
      this.getMode(),
      this.getAssets(),
      this.getPositions(),
      this.getRisk(),
      this.getJournal(),
      this.getActivity(),
      this.getConfig(),
      this.isAutoTrading(),
      this.isSafetyBlocked()
    ]);
    const analysis = await this.ctx.storage.get("analysis") ?? { symbol: assets[0] ?? "BTCUSDT", bias: "NEUTRAL", status: "WAITING", setups: [], events: [] };
    const status = { ...baseState(mode, assets), autoTrading, safetyBlocked };
    return { status, analysis, risk, positions: { open: positions.filter((position) => position.status === "OPEN"), all: positions }, journal: { entries: journal }, activity: { events: activity }, config, configuredAssets: assets, timestamp: Date.now() };
  }
  async broadcastState() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const frame = JSON.stringify({ type: "state", payload: await this.getStreamState() });
    for (const socket of sockets) {
      try {
        socket.send(frame);
      } catch {
      }
    }
  }
  /**
   * Rate limiting is held in memory rather than storage. A Durable Object is a
   * single instance, so the window does not need to survive eviction, and
   * persisting it wrote a storage row on every request.
   */
  requestTimes = [];
  async allowRequest(limit = 120, windowMs = 6e4) {
    const now = Date.now();
    this.requestTimes = this.requestTimes.filter((t) => t > now - windowMs);
    if (this.requestTimes.length >= limit) return false;
    this.requestTimes.push(now);
    return true;
  }
  async ensureAnalysisAlarm() {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + 5 * 6e4);
  }
  async alarm() {
    let nextDelay = STEADY_TICK_MS;
    try {
      await this.runAnalysis();
      await this.tickAgents();
      nextDelay = await this.ctx.storage.get("anyWarming") ? WARMING_TICK_MS : STEADY_TICK_MS;
      if (nextDelay === STEADY_TICK_MS) await this.probeProviderHealth();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + nextDelay);
    }
  }
  /**
   * Advance every active agent and record the conditions they observed. Agent
   * failures are contained: one agent erroring must not stop the others or the
   * alarm from rescheduling.
   */
  async tickAgents() {
    let results;
    try {
      results = await this.agents().tickAll();
    } catch (error) {
      console.error(JSON.stringify({
        event: "agent_tick_failed",
        message: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      }));
      return;
    }
    if (!results.length) return;
    const conditions = [];
    for (const result of results) {
      for (const [symbol, reading] of Object.entries(result.regimes)) {
        conditions.push({ symbol, ...reading });
      }
      console.log(JSON.stringify({
        event: "agent_tick",
        agent: result.name,
        supervisor: result.supervisor.state,
        headline: result.supervisor.headline,
        applied: result.applied.map((a) => `${a.field} ${a.from}->${a.to}`),
        closedTrades: result.performance.closedTrades,
        winRate: Number(result.performance.winRate.toFixed(1)),
        netPnl: Number(result.performance.netPnl.toFixed(2)),
        openPositions: result.performance.openPositions,
        timestamp: Date.now()
      }));
    }
    if (conditions.length) {
      const previous = (await this.ctx.storage.get("marketConditions"))?.conditions ?? [];
      const merged = new Map(previous.map((c) => [c.symbol, c]));
      for (const condition of conditions) merged.set(condition.symbol, condition);
      await this.ctx.storage.put({
        marketConditions: { conditions: [...merged.values()], updatedAt: Date.now() }
      });
    }
  }
  async probeProviderHealth() {
    const probes = [
      ["binance", "https://api.binance.com/api/v3/time"],
      ["bybit", "https://api.bybit.com/v5/market/time"],
      ["coinbase", "https://api.exchange.coinbase.com/time"],
      ["okx", "https://www.okx.com/api/v5/public/time"],
      ["bitget", "https://api.bitget.com/api/v2/public/time"],
      ["kucoin", "https://api.kucoin.com/api/v1/timestamp"]
    ];
    const results = await Promise.all(probes.map(async ([provider, url]) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5e3) });
        return { provider, status: response.ok ? "healthy" : "degraded", code: response.status };
      } catch {
        return { provider, status: "unavailable", code: 0 };
      }
    }));
    await this.ctx.storage.put("providerHealth", { checkedAt: Date.now(), providers: results });
  }
  /**
   * Run the deterministic Smart Money engine for a symbol and publish the
   * result. Every field below is produced by `@smc/core`; nothing here invents
   * a bias, a setup or a fill.
   */
  async runAnalysis(symbolOverride) {
    const assets = symbolOverride ? [symbolOverride] : await this.getAssets();
    const symbol = symbolOverride ?? assets[0] ?? "BTCUSDT";
    try {
      const [mode, storedRisk, storedStrategy, autoTrading, safetyBlocked] = await Promise.all([
        this.getMode(),
        this.ctx.storage.get("risk"),
        this.ctx.storage.get("strategy"),
        this.isAutoTrading(),
        this.isSafetyBlocked()
      ]);
      const tick = await this.runtime().tick(symbol, {
        mode,
        risk: { ...DEFAULT_RISK, ...storedRisk ?? {} },
        strategy: storedStrategy,
        autoTrading,
        safetyBlocked
      });
      const engine = this.runtime().engineFor(symbol);
      const analysis = serializeAnalysis(tick);
      const writes = {
        analysis,
        feed: {
          lastPrice: lastCloseOf(tick),
          lastPollAt: Date.now(),
          lastError: null,
          provider: tick.exchange,
          providerStatus: "healthy"
        }
      };
      if (!symbolOverride) {
        const positions = engine.getPositions();
        const journal = engine.getJournal().getAll().slice(0, 200);
        const activity = engine.getActivity().getAll().slice(0, 200);
        const signature = `${positions.length}:${journal.length}:${activity.length}:${engine.getRiskState().equity.toFixed(4)}`;
        if (signature !== this.lastEngineSignature) {
          this.lastEngineSignature = signature;
          writes.positions = positions;
          writes.journal = journal;
          writes.activity = activity;
          const equityHistory = await this.ctx.storage.get("equityHistory") ?? [];
          const last = equityHistory.at(-1);
          if (!last || Date.now() - last.timestamp >= 6e4) {
            writes.equityHistory = [...equityHistory, { timestamp: Date.now(), equity: engine.getRiskState().equity }].slice(-2e3);
          }
        }
      }
      await this.ctx.storage.put(writes);
      const snaps = tick.analysis.snapshots;
      console.log(JSON.stringify({
        event: "analysis_completed",
        symbol,
        provider: tick.exchange,
        bias: tick.analysis.bias,
        status: tick.status,
        warming: tick.warming,
        executed: tick.executed,
        rejected: tick.rejected,
        setups: tick.analysis.setups.length,
        // Per-timeframe structure, so a neutral bias can be traced to the
        // timeframe responsible instead of guessed at.
        tf: Object.fromEntries(
          Object.entries(snaps).filter(([, snap]) => snap).map(([timeframe, snap]) => [timeframe, {
            candles: snap.candles.length,
            trend: snap.structure.trend,
            freshObs: snap.orderBlocks.filter((b) => b.status === "FRESH").length,
            fvgs: snap.fvgs.length,
            liquidity: snap.liquidityZones.length
          }])
        ),
        reason: tick.analysis.noTradeReason ?? null,
        blocked: tick.blockedReasons,
        timestamp: Date.now()
      }));
      await this.persistDurably(tick);
      let anyWarming = tick.warming;
      if (!symbolOverride && assets.length > 1) {
        const scans = [analysis];
        for (const asset of assets.slice(1)) {
          const scan = await this.runAnalysis(asset);
          if (scan.warming === true) anyWarming = true;
          scans.push(scan);
        }
        await this.ctx.storage.put({ analysis, marketAnalyses: scans });
      }
      if (!symbolOverride && anyWarming !== this.lastAnyWarming) {
        this.lastAnyWarming = anyWarming;
        await this.ctx.storage.put({ anyWarming });
      }
      if (!symbolOverride) await this.broadcastState();
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market data request failed";
      await this.ctx.storage.put({
        feed: { lastError: message, lastPollAt: Date.now(), provider: "unavailable", providerStatus: "error" }
      });
      console.error(JSON.stringify({ event: "analysis_failed", symbol, message, timestamp: Date.now() }));
      return await this.ctx.storage.get("analysis") ?? {
        symbol,
        exchange: "multi-exchange",
        bias: "UNCLEAR",
        status: "MARKET_DATA_UNAVAILABLE",
        updatedAt: Date.now(),
        topDown: {
          htf: { timeframe: "4H", trend: "NEUTRAL", strength: "WEAK" },
          mtf: { timeframe: "1H", trend: "NEUTRAL", strength: "WEAK" },
          ltf: { timeframe: "15M", trend: "NEUTRAL" }
        },
        setups: [],
        events: []
      };
    }
  }
  /** Remember which account this session belongs to, for durable writes. */
  async setUserId(userId) {
    if (await this.ctx.storage.get("userId") !== userId) {
      await this.ctx.storage.put("userId", userId);
    }
  }
  // ---- session registry -------------------------------------------------
  // A dedicated instance of this class (named "registry") tracks which accounts
  // have an analysis loop, so the cron can re-arm them. Sessions are per user
  // and a cron invocation has no user context of its own.
  async registerSession(userId) {
    const users = await this.ctx.storage.get("knownUsers") ?? [];
    if (!users.includes(userId)) {
      await this.ctx.storage.put("knownUsers", [...users, userId].slice(-1e3));
    }
  }
  async listSessions() {
    return await this.ctx.storage.get("knownUsers") ?? [];
  }
  /**
   * Ship whatever is new since the last successful write to MongoDB. Watermarks
   * are only advanced when the write succeeds, so a failed or skipped batch is
   * retried on the next tick rather than silently lost.
   */
  async persistDurably(tick) {
    const userId = await this.ctx.storage.get("userId");
    if (!userId) return;
    const symbol = tick.symbol;
    const watermarkKey = `persisted:candles:${symbol}`;
    const sentSetupsKey = `persisted:setups:${symbol}`;
    const [watermark, sentSetups] = await Promise.all([
      this.ctx.storage.get(watermarkKey),
      this.ctx.storage.get(sentSetupsKey)
    ]);
    const marks = watermark ?? {};
    const seen = sentSetups ?? {};
    const candles = Object.values(tick.analysis.snapshots).flatMap((snapshot) => snapshot?.candles ?? []).filter((candle) => candle.timestamp >= (marks[candle.timeframe] ?? 0));
    const setups = tick.analysis.setups.filter((setup) => seen[setup.id] !== setup.status);
    const result = await sendIngest(
      { url: this.env.PLATFORM_API_URL ?? "", secret: this.env.WORKER_AUTH_SECRET ?? "" },
      {
        userId,
        candles,
        setups,
        run: {
          symbol,
          exchange: tick.exchange,
          bias: tick.analysis.bias,
          status: tick.status,
          warming: tick.warming,
          setupsSeen: tick.analysis.setups.length,
          validSetups: tick.analysis.setups.filter((s) => s.status === "VALID").length,
          rejectedSetups: tick.rejected,
          executedSetups: tick.executed,
          timestamp: Date.now()
        }
      }
    );
    if (!result.sent) {
      if (result.reason && !result.reason.includes("not configured")) {
        console.warn(JSON.stringify({ event: "ingest_failed", symbol, reason: result.reason, timestamp: Date.now() }));
      }
      return;
    }
    for (const candle of candles) {
      marks[candle.timeframe] = Math.max(marks[candle.timeframe] ?? 0, candle.timestamp);
    }
    for (const setup of setups) seen[setup.id] = setup.status;
    await this.ctx.storage.put({
      [watermarkKey]: marks,
      // Bound the map so a long-running session cannot grow it without limit.
      [sentSetupsKey]: Object.fromEntries(Object.entries(seen).slice(-500))
    });
  }
  /**
   * Chart payload for one symbol/timeframe. Kept out of `/api/analysis` and the
   * WebSocket state frame because candle buffers and zone geometry are far
   * larger than the summary those carry.
   */
  async getChart(symbol, timeframe) {
    const engine = this.runtime().engineFor(symbol);
    if (!engine) return { symbol, timeframe: timeframe ?? null, available: false, reason: "This market has not been analysed yet." };
    const analysis = engine.analysis.analyze();
    const tf = timeframe ?? engine.strategyConfig.timeframes.ltf;
    const snapshot = analysis.snapshots[tf];
    if (!snapshot) return { symbol, timeframe: tf, available: false, reason: "No candles for this timeframe yet." };
    return {
      symbol,
      exchange: analysis.exchange,
      timeframe: tf,
      available: true,
      updatedAt: analysis.updatedAt,
      candles: snapshot.candles,
      structure: snapshot.structure,
      bos: snapshot.bos,
      choch: snapshot.choch,
      sweeps: snapshot.sweeps,
      liquidityZones: snapshot.liquidityZones,
      fvgs: snapshot.fvgs,
      orderBlocks: snapshot.orderBlocks,
      supplyDemand: snapshot.supplyDemand,
      momentum: snapshot.momentum,
      setups: analysis.setups,
      positions: engine.getOpenPositions().filter((p) => p.symbol === symbol)
    };
  }
  async getAnalysis() {
    return this.runAnalysis();
  }
  async getMarketAnalyses() {
    await this.runAnalysis();
    return await this.ctx.storage.get("marketAnalyses") ?? [await this.getAnalysis()];
  }
  async getPositions() {
    return await this.ctx.storage.get("positions") ?? [];
  }
  async getActivity() {
    return await this.ctx.storage.get("activity") ?? [];
  }
  async getJournal() {
    return await this.ctx.storage.get("journal") ?? [];
  }
  /**
   * Risk state comes from the engine's own risk engine whenever a warm engine
   * exists, so the dashboard reports the numbers that actually gated trades.
   * The persisted snapshot is used only before the first tick of a cold start.
   */
  async getRisk() {
    const assets = await this.getAssets();
    const limits = { ...DEFAULT_RISK, ...await this.ctx.storage.get("risk") ?? {} };
    const engine = this.runtime().engineFor(assets[0] ?? "BTCUSDT");
    if (engine) {
      const state = engine.getRiskState();
      return {
        state: {
          equity: state.equity,
          equityDayStart: state.equityDayStart,
          peakEquity: state.peakEquity,
          tradesToday: state.tradesToday,
          realizedPnlToday: state.realizedPnlToday,
          openPositions: engine.getOpenPositions(),
          usedExposure: state.usedExposure,
          usedCorrelatedExposure: state.usedCorrelatedExposure,
          dailyLossReached: state.dailyLossReached,
          drawdownReached: state.drawdownReached
        },
        limits
      };
    }
    const snapshot = await this.ctx.storage.get(`engine:${assets[0] ?? "BTCUSDT"}`);
    const risk = snapshot?.risk;
    return {
      state: {
        equity: risk?.equity ?? STARTING_EQUITY,
        equityDayStart: risk?.equityDayStart ?? STARTING_EQUITY,
        peakEquity: risk?.peakEquity ?? STARTING_EQUITY,
        tradesToday: risk?.tradesToday ?? 0,
        realizedPnlToday: risk?.realizedPnlToday ?? 0,
        openPositions: (await this.getPositions()).filter((position) => position.status === "OPEN"),
        usedExposure: risk?.usedExposure ?? 0,
        usedCorrelatedExposure: risk?.usedCorrelatedExposure ?? 0,
        dailyLossReached: Boolean(risk?.dailyLossReached),
        drawdownReached: Boolean(risk?.drawdownReached)
      },
      limits
    };
  }
  /** Feed telemetry recorded by the most recent analysis tick. */
  async getFeed() {
    return await this.ctx.storage.get("feed") ?? { lastPollAt: null, lastError: null, provider: "unknown" };
  }
  async getEquityHistory() {
    return await this.ctx.storage.get("equityHistory") ?? [];
  }
  /**
   * §60 analytics, measured by the same code the backtester uses so paper,
   * live and historical results are directly comparable.
   */
  async getAnalytics() {
    const [positions, equityCurve, marketAnalyses, analysis] = await Promise.all([
      this.getPositions(),
      this.getEquityHistory(),
      this.ctx.storage.get("marketAnalyses"),
      this.ctx.storage.get("analysis")
    ]);
    const sources = marketAnalyses?.length ? marketAnalyses : analysis ? [analysis] : [];
    const setups = sources.flatMap((result) => {
      const symbol = String(result.symbol ?? "");
      return (result.setups ?? []).map((setup) => ({ ...setup, symbol: setup.symbol ?? symbol }));
    });
    return {
      ...computePerformance({
        positions,
        setups,
        equityCurve,
        startingEquity: STARTING_EQUITY
      }),
      equityCurve,
      updatedAt: Date.now()
    };
  }
  /** §53 — one position with its full management timeline and originating setup. */
  async getTrade(positionId) {
    const positions = await this.getPositions();
    const position = positions.find((item) => item.id === positionId || item.setupId === positionId);
    if (!position) return { found: false, reason: "No position with that identifier." };
    const [marketAnalyses, analysis, journal] = await Promise.all([
      this.ctx.storage.get("marketAnalyses"),
      this.ctx.storage.get("analysis"),
      this.getJournal()
    ]);
    const sources = marketAnalyses?.length ? marketAnalyses : analysis ? [analysis] : [];
    const setup = sources.flatMap((result) => result.setups ?? []).find((item) => item.id === position.setupId);
    return {
      found: true,
      position,
      // The originating setup may have aged out of the current analysis window.
      setup: setup ?? null,
      events: position.events ?? [],
      journal: journal.filter((entry) => {
        const data = entry.data;
        return data?.setupId === position.setupId || data?.positionId === position.id;
      })
    };
  }
  async restorePaperState(state) {
    const existing = await this.getPositions();
    const existingJournal = await this.getJournal();
    if (existing.length || existingJournal.length) return { restored: false, reason: "The active Worker session already contains paper state." };
    if (!Array.isArray(state.positions) || !Array.isArray(state.journal) || !Array.isArray(state.activity) || !Number.isFinite(state.equity)) {
      throw new Error("A valid MongoDB paper-state snapshot is required.");
    }
    const timestamp = Number.isFinite(state.updatedAt) ? Number(state.updatedAt) : Date.now();
    await this.ctx.storage.put({
      positions: state.positions.slice(0, 500),
      journal: state.journal.slice(0, 500),
      activity: state.activity.slice(0, 500),
      equityHistory: [{ timestamp, equity: Number(state.equity) }],
      restoredAt: Date.now()
    });
    return { restored: true };
  }
  async getProviderHealth() {
    return await this.ctx.storage.get("providerHealth") ?? { provider: "unknown", status: "pending" };
  }
  async getConfig() {
    return { strategy: await this.ctx.storage.get("strategy") ?? { version: "cloudflare-paper-v1" }, risk: { ...DEFAULT_RISK, ...await this.ctx.storage.get("risk") ?? {} } };
  }
  async updateConfig(patch) {
    const current = await this.getConfig();
    const risk = { ...current.risk, ...patch.risk ?? {} };
    await this.ctx.storage.put({ risk, strategy: { ...current.strategy, ...patch.strategy ?? {} } });
    return this.getConfig();
  }
  /**
   * Historical replay using the real SMC engine. The strategy, risk and
   * position-management code paths are the same ones paper and live trading
   * use, so a backtest here reflects what the engine would actually have done.
   */
  async runBacktest(startTime, endTime, startingEquity = 1e4) {
    const symbol = (await this.getAssets())[0] ?? "BTCUSDT";
    const storedRisk = await this.ctx.storage.get("risk");
    const storedStrategy = await this.ctx.storage.get("strategy");
    const runtime = this.runtime();
    const strategyConfig = runtime.strategyConfigFor(symbol, storedStrategy);
    const riskConfig = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, ...storedRisk ?? {} });
    const ltfMs = TIMEFRAME_DURATION_MS[strategyConfig.timeframes.ltf];
    const estimatedCandles = Math.ceil((endTime - startTime) / ltfMs);
    if (estimatedCandles > MAX_BACKTEST_CANDLES) {
      const maxDays = Math.floor(MAX_BACKTEST_CANDLES * ltfMs / 864e5);
      throw new Error(
        `That range needs about ${estimatedCandles} ${strategyConfig.timeframes.ltf} candles, above the ${MAX_BACKTEST_CANDLES} this deployment replays in one request. Choose a range of roughly ${maxDays} days or fewer.`
      );
    }
    const result = await runBacktest({
      symbol,
      exchange: "multi-exchange",
      strategyConfig,
      riskConfig,
      startTime,
      endTime,
      startingEquity,
      marketData: new MultiExchangeMarketData({ timeoutMs: 1e4 })
    });
    console.log(JSON.stringify({
      event: "backtest_completed",
      symbol,
      trades: result.stats.totalTrades,
      validSetups: result.validSetups,
      rejectedSetups: result.rejectedSetups,
      netPnl: result.stats.netPnl,
      timestamp: Date.now()
    }));
    return { ...result, symbol, strategyVersion: strategyConfig.version };
  }
  /**
   * Auto trading defaults to on in PAPER mode. Paper trading risks nothing and
   * observing the engine trade is the entire point of the deployment, so a
   * session that has never been configured should not sit idle. An explicit
   * choice is always respected: turning it off stores `false`, which wins here.
   * Any other mode stays off until deliberately enabled.
   */
  async isAutoTrading() {
    const stored = await this.ctx.storage.get("autoTrading");
    if (typeof stored === "boolean") return stored;
    return await this.getMode() === "PAPER";
  }
  async isSafetyBlocked() {
    return await this.ctx.storage.get("safetyBlocked") ?? false;
  }
  async setSafetyBlocked(blocked, reason = "Manual safety control") {
    await this.ctx.storage.put({ safetyBlocked: blocked, safetyReason: reason });
    return { safetyBlocked: blocked };
  }
  async setAutoTrading(enabled) {
    await this.ctx.storage.put("autoTrading", enabled);
    return { enabled };
  }
  async getMode() {
    return await this.ctx.storage.get("mode") ?? "PAPER";
  }
  async setMode(mode) {
    if (mode === "LIVE" || !["ANALYSIS_ONLY", "PAPER"].includes(mode)) throw new Error("LIVE trading is not enabled on this deployment.");
    await this.ctx.storage.put({ mode, updatedAt: Date.now() });
    return { mode };
  }
  async getLiveTradingReadiness() {
    return {
      ready: false,
      executionEnabled: false,
      blockers: [
        "Real exchange order adapters are not enabled.",
        "Order idempotency and status reconciliation are required.",
        "A trading-enabled, validated exchange connection is required.",
        "An explicit live-trading approval gate is required."
      ]
    };
  }
  async getAssets() {
    return await this.ctx.storage.get("assets") ?? DEFAULT_ASSETS;
  }
  async setAssets(assets) {
    const normalized = [...new Set(assets.map((asset) => asset.trim().toUpperCase()).filter(Boolean))].slice(0, 30);
    if (!normalized.length) throw new Error("At least one market pair is required.");
    await this.ctx.storage.put({ assets: normalized, updatedAt: Date.now() });
    return normalized;
  }
};
var src_default = {
  /**
   * Cron watchdog. Analysis itself runs in each account's Durable Object alarm,
   * which self-reschedules and gets its own CPU budget per invocation. This
   * handler only re-arms alarms that have stopped, so the engine recovers
   * without waiting for someone to open the dashboard. Doing the analysis here
   * instead would put every account into a single invocation's CPU budget.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const registry = env.TRADING_SESSION.getByName("registry");
      const users = await registry.listSessions();
      for (const userId of users) {
        try {
          await env.TRADING_SESSION.getByName(`user:${userId}`).ensureAnalysisAlarm();
        } catch (error) {
          console.error(JSON.stringify({
            event: "alarm_rearm_failed",
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now()
          }));
        }
      }
      console.log(JSON.stringify({ event: "cron_rearm", sessions: users.length, timestamp: Date.now() }));
    })());
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request, env) });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(request, env, { status: "ok", service: "smc-trader-worker", authRequired: true, durableObjectBinding: Boolean(env.TRADING_SESSION), timestamp: Date.now() });
    const userId = await authenticatedUser(request, env);
    if (!userId) return json(request, env, { error: "Authentication is required." }, 401);
    const session = env.TRADING_SESSION.getByName(`user:${userId}`);
    if (!await session.allowRequest()) return json(request, env, { error: "Rate limit exceeded. Please retry in one minute." }, 429);
    await session.setUserId(userId);
    await session.ensureAnalysisAlarm();
    await env.TRADING_SESSION.getByName("registry").registerSession(userId);
    const [mode, assets] = await Promise.all([session.getMode(), session.getAssets()]);
    const state = baseState(mode, assets);
    if (url.pathname === "/api/events" && request.headers.get("upgrade")?.toLowerCase() === "websocket") return session.fetch(request);
    if (url.pathname === "/api/status" && request.method === "GET") {
      const [analysis, positions, autoTrading, safetyBlocked] = await Promise.all([session.getAnalysis(), session.getPositions(), session.isAutoTrading(), session.isSafetyBlocked()]);
      const feed = await session.getFeed();
      return json(request, env, { ...state, autoTrading, safetyBlocked, analysis, positions, feed: { ...state.feed, ...feed, running: !feed.lastError } });
    }
    if (url.pathname === "/api/assets") {
      if (request.method === "GET") return json(request, env, { assets });
      if (request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        if (!Array.isArray(body.assets) || !body.assets.every((asset) => typeof asset === "string")) return json(request, env, { error: "assets must be a string array" }, 400);
        try {
          return json(request, env, { assets: await session.setAssets(body.assets) });
        } catch (error) {
          return json(request, env, { error: String(error) }, 400);
        }
      }
    }
    if (url.pathname === "/api/mode" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      try {
        return json(request, env, await session.setMode(body.mode));
      } catch (error) {
        return json(request, env, { error: error instanceof Error ? error.message : "Invalid mode" }, 400);
      }
    }
    if (url.pathname === "/api/analysis" && request.method === "GET") return json(request, env, await session.getAnalysis());
    if (url.pathname === "/api/agents") {
      if (request.method === "GET") return json(request, env, await session.listAgents());
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const result = await session.createAgent(body);
        return json(request, env, result, result.error ? 400 : 201);
      }
    }
    if (url.pathname.startsWith("/api/agents/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/agents/".length));
      if (request.method === "PATCH") {
        const body = await request.json().catch(() => ({}));
        const result = await session.updateAgent(id, body);
        return json(request, env, result, result.error ? 400 : 200);
      }
      if (request.method === "DELETE") return json(request, env, await session.deleteAgent(id));
    }
    if (url.pathname === "/api/markets" && request.method === "GET") return json(request, env, await session.availableMarkets());
    if (url.pathname === "/api/portfolio" && request.method === "GET") return json(request, env, await session.portfolio());
    if (url.pathname === "/api/trades" && request.method === "GET") return json(request, env, await session.agentTrades());
    if (url.pathname === "/api/market-conditions" && request.method === "GET") return json(request, env, await session.marketConditions());
    if (url.pathname === "/api/news" && request.method === "GET") return json(request, env, await session.news());
    if (url.pathname === "/api/capital" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!Number.isFinite(body.amount)) return json(request, env, { error: "A numeric amount is required." }, 400);
      return json(request, env, await session.setPaperCapital(Number(body.amount)));
    }
    if (url.pathname === "/api/analytics" && request.method === "GET") return json(request, env, await session.getAnalytics());
    if (url.pathname === "/api/trade" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json(request, env, { error: "A position or setup id is required." }, 400);
      return json(request, env, await session.getTrade(id));
    }
    if (url.pathname === "/api/chart" && request.method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? assets[0] ?? "BTCUSDT";
      return json(request, env, await session.getChart(symbol, url.searchParams.get("timeframe") ?? void 0));
    }
    if (url.pathname === "/api/live-readiness" && request.method === "GET") return json(request, env, await session.getLiveTradingReadiness());
    if (url.pathname === "/api/risk" && request.method === "GET") return json(request, env, await session.getRisk());
    if (url.pathname === "/api/equity-history" && request.method === "GET") return json(request, env, { points: await session.getEquityHistory() });
    if (url.pathname === "/api/paper-state/restore" && request.method === "PUT") {
      const body = await request.json().catch(() => ({}));
      try {
        return json(request, env, await session.restorePaperState(body));
      } catch (error) {
        return json(request, env, { error: error instanceof Error ? error.message : "Paper state restoration failed." }, 400);
      }
    }
    if (url.pathname === "/api/provider-health" && request.method === "GET") return json(request, env, await session.getProviderHealth());
    if (url.pathname === "/api/config") {
      if (request.method === "GET") return json(request, env, await session.getConfig());
      if (request.method === "PATCH") {
        const body = await request.json().catch(() => ({}));
        return json(request, env, await session.updateConfig(body));
      }
    }
    if (url.pathname === "/api/backtest" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!Number.isFinite(body.startTime) || !Number.isFinite(body.endTime) || body.endTime <= body.startTime) return json(request, env, { error: "A valid start and end time are required." }, 400);
      try {
        return json(request, env, await session.runBacktest(body.startTime, body.endTime, body.startingEquity));
      } catch (error) {
        return json(request, env, { error: error instanceof Error ? error.message : "Backtest failed" }, 400);
      }
    }
    if (url.pathname === "/api/positions" && request.method === "GET") {
      const positions = await session.getPositions();
      return json(request, env, { open: positions.filter((position) => position.status === "OPEN"), all: positions });
    }
    if (url.pathname === "/api/journal" && request.method === "GET") return json(request, env, { entries: await session.getJournal() });
    if (url.pathname === "/api/activity" && request.method === "GET") return json(request, env, { events: await session.getActivity() });
    if (url.pathname === "/api/autotrading" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (typeof body.enabled !== "boolean") return json(request, env, { error: "enabled must be a boolean" }, 400);
      if (mode !== "PAPER" && body.enabled) return json(request, env, { error: "Auto trading is only available in PAPER mode until an exchange is connected." }, 400);
      return json(request, env, await session.setAutoTrading(body.enabled));
    }
    if (url.pathname === "/api/safemode" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return json(request, env, await session.setSafetyBlocked(true, body.reason));
    }
    if (url.pathname === "/api/safemode/exit" && request.method === "POST") return json(request, env, await session.setSafetyBlocked(false));
    if (url.pathname === "/api/connections" && request.method === "GET") return json(request, env, { connections: [], available: false, setupError: "Exchange credentials are not enabled in the Cloudflare paper-trading deployment." });
    return json(request, env, { error: "Not found" }, 404);
  }
};

// ../../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// .wrangler/tmp/bundle-S9FwCt/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default
];
var middleware_insertion_facade_default = src_default;

// ../../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-S9FwCt/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  TradingSession,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
