# Deployment

## Vercel (dashboard and authentication)

Deploy the repository root. `vercel.json` builds `apps/web` and exposes
same-origin MongoDB authentication functions at `/api/auth/*`.

Set these Vercel variables (Production, Preview, and Development as needed):

- `MONGODB_URI` and `MONGODB_DB=smctrader`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=https://<vercel-domain>/api/auth/google/callback`
- `AUTH_REDIRECT_URL=https://<vercel-domain>/`
- `AUTH_COOKIE_SECURE=true`
- `VITE_API_BASE_URL`: deployed Cloudflare Worker URL, for example `https://smc-trader-api.<account>.workers.dev`
- `CREDENTIAL_ENCRYPTION_KEY`: envelope key for exchange API credentials at
  rest. Without it `/api/connections` returns 503 on every dashboard load and
  the Exchanges page stays unavailable. Paper trading is unaffected, so this is
  only required before connecting an exchange account.
- `WORKER_AUTH_SECRET`: shared secret. It signs the short-lived tokens the
  dashboard uses to call the Worker, and the Worker uses it to sign the batches
  it posts back to `/api/auth`-adjacent `/api/ingest`. Use a long random value
  and set the identical value in Cloudflare.

The deployment stays within the Hobby plan's limit of 12 serverless functions:
`/api/auth` (all authentication routes, via a rewrite), `/api/connections` and
`/api/ingest`.

### Durable market storage

`/api/ingest` writes candles, setup decisions and analysis-run summaries to
MongoDB on the Worker's behalf, because the MongoDB driver needs a TCP socket
that the Workers runtime does not provide. Collections and indexes are created
on first use:

- `candles` — unique on `(symbol, exchange, timeframe, timestamp)`. Market data
  is shared across accounts rather than duplicated per user.
- `setup_decisions` — unique on `(userId, setupId)`; a setup's row is updated as
  its status changes, and `createdAt` keeps the original decision time.
- `analysis_runs` — append-only summaries indexed by `(userId, timestamp)`.

Requests are rejected unless they carry a token signed with `WORKER_AUTH_SECRET`
whose payload matches a hash of the exact body, so a captured token cannot be
replayed with different data. Tokens expire after 60 seconds.

Do not prefix MongoDB or Google variables with `VITE_`; Vite would expose them
to every browser. Add the same callback address to Google Cloud's Authorized
redirect URIs.

## Cloudflare Worker (API starter)

The Worker holds the selected `PAPER` or `ANALYSIS_ONLY` mode in a SQLite-backed Durable Object and exposes `/health`, `/api/status`, and `/api/mode`. It intentionally refuses `LIVE`; exchange order execution must be migrated and independently audited before it is exposed on a serverless edge runtime.

1. Generate Worker types after any binding change: `npm run types -w @smc/worker`.
2. Sign in to Cloudflare from a terminal: `npm exec wrangler login`.
3. Deploy: `npm run deploy:worker`.
4. In Cloudflare, add `ALLOWED_ORIGIN` as the exact Vercel dashboard origin.
5. Set Vercel's `VITE_API_BASE_URL` to the Worker URL and redeploy the dashboard.
6. In Cloudflare, set `WORKER_AUTH_SECRET` to the same value as Vercel's, and
   `PLATFORM_API_URL` to the Vercel origin (for example
   `https://<vercel-domain>`). Without `PLATFORM_API_URL` the Worker keeps
   trading normally and simply skips durable storage; it never blocks analysis
   or position management on a storage outage.

The free Workers plan permits 100,000 requests per day, 10 ms CPU per invocation, five cron triggers per account, SQLite-backed Durable Objects, and 10,000 Queue operations per day. This is suitable for a controlled paper-trading pilot, not an unattended live-trading service. Keep Atlas credentials and exchange secrets out of browser variables and rotate any credential that was shared in chat.
