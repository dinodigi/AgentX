# CDN Setup — delivery edge cache (Cloudflare)

**Goal:** public delivery reads are served from Cloudflare's edge instead of hitting Render + Neon on every request. Expected effect: ~90%+ of read traffic never reaches origin → less Render load, fewer Neon queries/CU-hours (COGS), faster responses worldwide.

## Architecture (why it's a Worker, not plain CDN caching)

Every delivery read (`GET /api/v1/{collection}`) is **Bearer-token authenticated**, and the URL does **not** identify the project — the token does. The same URL serves different tenants' data per token, so a URL-keyed cache would **leak content across tenants**. The design therefore has two halves:

1. **Origin contract** (shipped in code, `lib/delivery-http.ts`):
   - Public reads — no `x-user-token`, no owner row-clauses — get `Cache-Control: max-age=0, s-maxage=60, stale-while-revalidate=300` + `Vary: authorization, x-user-token` + the existing strong ETag.
   - Everything else (user-scoped reads, changes feed, POSTs, errors) stays `no-cache` / uncached.
   - `max-age=0` keeps direct clients revalidating exactly as before — only **shared** caches gain the TTL.
   - Kill switch: env `DELIVERY_EDGE_TTL_SECONDS=0` disables the header entirely (redeploy to apply). Default 60.
2. **Edge worker** ([infra/cloudflare/delivery-cache-worker.js](../infra/cloudflare/delivery-cache-worker.js)):
   - Caches **only** GETs carrying `authorization` and **no** `x-user-token`, and **only** responses origin marked `s-maxage`.
   - Cache key = URL + SHA-256(token) → per-tenant slots, zero cross-tenant risk. Raw token never stored.
   - Serves 304s at the edge; strips client conditionals on fill so a 304 is never cached.
   - `x-edge-cache: HIT | MISS-STORED | MISS` debug header on every response.

## Setup steps (operator, ~15 min)

1. **Zone:** add `pluggie.app` to Cloudflare (free plan is fine) and move the domain's nameservers to Cloudflare, OR if already on Cloudflare skip.
2. **DNS:** the app hostname (`pluggie.app` / `www`) stays a CNAME to the Render host — set it to **Proxied** (orange cloud). Render's TLS keeps working (Cloudflare ↔ Render over HTTPS; set SSL mode **Full (strict)**).
3. **Worker:** dashboard → Workers & Pages → Create → paste `infra/cloudflare/delivery-cache-worker.js` → deploy.
4. **Route:** add route `pluggie.app/api/v1/*` → this worker. **Do not** route `/api/mcp`, `/admin`, or anything else through it.
5. **Verify** (from any machine):
   ```sh
   # 1st request: x-edge-cache: MISS-STORED
   curl -si https://pluggie.app/api/v1/<collection> -H "authorization: Bearer <delivery-token>" | grep -i 'x-edge-cache\|cache-control'
   # 2nd request within 60s: x-edge-cache: HIT (origin untouched)
   # 304 at edge: repeat with -H 'if-none-match: <etag from above>' → HTTP 304, x-edge-cache: HIT
   ```
   Then confirm a user-scoped request bypasses: add `-H "x-user-token: anything"` → no `x-edge-cache` header at all (worker passed through).

## Operational notes

- **Staleness:** at most 60s after a write (TTL). Acceptable for site content; add purge-on-write (Cloudflare purge API from the entry-write path) later if it ever bites.
- **Rate limiting:** origin rate limits apply on fill only; edge HITs don't consume them — that's the point (the `?q=` search limiter still protects origin CPU, since distinct queries are distinct cache keys → each fill is limited).
- **Metering (Track 4 coupling — REVENUE-critical under usage billing):** edge HITs never reach origin, so `usage_daily` undercounts real delivery once this is live. The Track 4 meter must read **Cloudflare analytics** (GraphQL API, per-hostname/zone) for true delivery request counts; origin metering keeps counting the un-cached work.
- **Cost:** Cloudflare proxy = free. Workers free tier = 100k requests/day (plenty now); Workers Paid = $5/mo for 10M/month. R2 egress already free.
- **Scope today:** JSON delivery reads. Asset binaries are already edge-friendly (image route 302s to R2 public URLs with `max-age=31536000, immutable`).
