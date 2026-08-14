import { timeframeDuration, type Candle, type Timeframe } from "../types/candles.js";
import type { MarketDataProvider } from "./providers.js";

/**
 * Deterministic simulated market data for local development and paper-trading
 * demonstrations. It is never selected in production unless explicitly set
 * with MARKET_DATA_MODE=demo, and every candle is marked `simulated` by the
 * provider name exposed through the API.
 */
export class DemoMarketData implements MarketDataProvider {
  readonly name = "simulated";

  async getOHLCV(symbol: string, timeframe: Timeframe, startTime: number, endTime: number, limit = 1000): Promise<Candle[]> {
    const duration = timeframeDuration(timeframe);
    const end = Math.floor(endTime / duration) * duration;
    const count = Math.min(limit, Math.max(1, Math.ceil((end - startTime) / duration)));
    const first = end - (count - 1) * duration;
    const base = symbol.startsWith("BTC") ? 62_000 : symbol.startsWith("ETH") ? 3_200 : 145;
    const seed = [...symbol].reduce((total, char) => total + char.charCodeAt(0), 0);
    const candles: Candle[] = [];
    for (let index = 0; index < count; index += 1) {
      const timestamp = first + index * duration;
      const phase = (timestamp / duration + seed) * 0.11;
      const drift = index * base * 0.000045;
      const open = base + drift + Math.sin(phase) * base * 0.006;
      const close = open + Math.sin(phase * 1.7) * base * 0.0028;
      const spread = base * (0.0018 + Math.abs(Math.cos(phase)) * 0.0022);
      candles.push({
        symbol,
        exchange: "simulated",
        timeframe,
        timestamp,
        open,
        high: Math.max(open, close) + spread,
        low: Math.min(open, close) - spread,
        close,
        volume: 500 + Math.abs(Math.sin(phase * 0.7)) * 2_000,
      });
    }
    return candles;
  }

  async getTicker(symbol: string): Promise<{ price: number }> {
    const [latest] = await this.getOHLCV(symbol, "15M", Date.now() - 15 * 60_000, Date.now(), 1);
    return { price: latest.close };
  }

  async getMarkets(): Promise<string[]> {
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
  }
}
