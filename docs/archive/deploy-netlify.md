# Deploying to Netlify

Production site: **https://agentx-currents.netlify.app** (site id
`9e8c93e6-282d-4a18-b26d-017a88fd6864`, team `partners-w52dris`).
First deployed 2026-07-05 against the DEV resources (same Neon DB, dev-mode
Clerk, same R2 bucket) — dogfood posture; rotate tokens and split prod
resources per roadmap 2.5 when a real client depends on it.

## How to deploy

```bash
# NETLIFY_AUTH_TOKEN lives in .env.local (gitignored). Dev server MUST be
# stopped first — a local build alongside `next dev` corrupts .next.
export NETLIFY_AUTH_TOKEN=$(grep '^NETLIFY_AUTH_TOKEN=' .env.local | cut -d= -f2)
npx netlify-cli deploy --build --prod
```

Config lives in `netlify.toml` (@netlify/plugin-nextjs). Env vars are set on
the site (`netlify env:import .env` seeded all 12); changing one:
`npx netlify-cli env:set KEY value`.

## Production smoke

```bash
SMOKE_BASE=https://agentx-currents.netlify.app node --env-file=.env --test \
  --test-concurrency=1 scripts/smoke/{01,02,03,07,08,11,12,13,14,15,16}*.test.mjs
```

Suites 04/05/06/09/10 are local-only: they depend on 127.0.0.1 webhook
receivers / mock issuers (unreachable FROM Netlify) or the in-memory rate
limiter (per-lambda in prod, so the 429 test can't trip it deterministically).

## Platform findings (verified empirically)

- **Netlify's CDN strips `If-None-Match` before functions run** — origin-level
  304s are impossible; the delivery API still emits ETags (used on other
  hosts, and by Netlify's CDN if edge caching is ever enabled via
  `Netlify-CDN-Cache-Control`, at the cost of bounded staleness). The smoke
  test detects Netlify (`x-nf-request-id`) and relaxes only the 304 assert.
- **after() works on Netlify** — see the canary result in this file's history;
  webhook/email emits and audit writes survive the response being sent.
- Rate limiting is per-lambda until a shared RateLimitStore impl lands
  (lib/ratelimit.ts interface; Upstash is the intended swap).
