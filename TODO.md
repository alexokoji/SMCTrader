# Trading platform implementation checklist

- [x] Initial provider failover: Binance, Binance Vision, Bybit, and Coinbase; active provider is returned with analysis.
- [ ] Persist candle history, analysis runs, setup decisions, activity and errors.
- [ ] Implement SMC structure, liquidity, order-block, FVG, confirmation and risk scoring.
- [ ] Complete paper account: balance, fills, fees, slippage, stop-loss, take-profit and journal.
- [ ] Add authenticated accounts and isolate each account's assets, connections and trading state.
- [ ] Encrypt exchange API credentials using Worker secrets and a per-account key envelope.
- [ ] Implement exchange adapters for Bybit, Bitget, OKX, KuCoin and Binance with permission validation.
- [ ] Add live execution only behind explicit confirmation, risk limits, idempotency and emergency kill switch.
- [ ] Persist production data in MongoDB through a Worker-compatible service/API; do not expose its URI to the browser.
- [ ] Add WebSocket/event streaming, monitoring, alerts, end-to-end tests and deployment health checks.
