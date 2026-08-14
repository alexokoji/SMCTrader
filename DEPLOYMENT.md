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

The free Workers plan permits 100,000 requests per day, 10 ms CPU per invocation, five cron triggers per account, SQLite-backed Durable Objects, and 10,000 Queue operations per day. This is suitable for a controlled paper-trading pilot, not an unattended live-trading service. Keep Atlas credentials and exchange secrets out of browser variables and rotate any credential that was shared in chat.
