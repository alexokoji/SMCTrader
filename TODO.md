# Trading platform implementation checklist

## Done

- [x] Deterministic SMC engine in `packages/core`: swing/structure, BOS, CHoCH,
      liquidity, sweeps, FVG, order blocks, supply/demand, premium/discount,
      momentum, top-down analysis, confluence scoring, entry models.
- [x] Risk engine with position sizing, RR gate, daily loss, drawdown, exposure
      and correlation limits; daily trade limit enforced as a ceiling (never a quota).
- [x] Paper execution adapter, position manager (partials, break-even, progressive SL),
      journal, activity feed, deterministic explanation engine, backtest engine.
- [x] Provider failover for public market data: Binance, Bybit, Bitget, OKX, KuCoin.
- [x] Authenticated accounts; encrypted exchange credential vault; account audit log.
- [x] **The Cloudflare Worker now runs the real engine.** It previously published a
      20/50 SMA crossover labelled as an SMC setup; that placeholder is gone.
- [x] Engine state survives a Durable Object eviction (`serialize`/`restore` on the
      strategy engine, journal, activity feed and position manager).
- [x] Cold-start replay is chunked to respect the Workers CPU ceiling; the UI reports
      `WARMING_UP` until the replay finishes rather than showing partial analysis.
- [x] `/api/chart` serves candles plus structure, liquidity, sweeps, FVG, order-block
      and supply/demand geometry.
- [x] Dashboard: chart with toggleable SMC overlays, deterministic analysis panel,
      full setup cards (hard rules, confluence, SL/TP reasoning), rejected-setups page.
- [x] Vercel deployment fits the Hobby function limit (13 serverless functions -> 2).

## Next

- [ ] Persist candle history, analysis runs and setup decisions in MongoDB, not only
      in Durable Object storage.
- [ ] Trade detail page (§53) and analytics dashboards (§60).
- [ ] Notifications: browser, email, Telegram (§64).
- [ ] Admin panel (§85), replay engine (§89) and strategy debug mode (§90).
- [ ] Exchange adapters beyond market data for Bybit, Bitget, OKX, KuCoin, including
      permission validation; Binance is the only private adapter today.
- [ ] Live execution behind explicit confirmation, order reconciliation, idempotency
      and the emergency kill switch. Live mode is still refused by the Worker.
- [ ] Event/news restriction engine (§40) and market-regime context (§39).
