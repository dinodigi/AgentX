# Status / Uptime Page — setup (v2 Track 7)

**Goal:** a public, GitHub-style uptime page for pluggie.app that stays up **when your own infra is down** — so it must be hosted **off** your infra. This is operator config, not code: the signal already exists.

## The signal (already shipped)

`GET https://pluggie.app/api/health` returns `{status:"ok", db:"up", deep, latencyMs}` — **always HTTP 200**. When the control DB is unreachable the STATUS CODE STAYS 200 and the body becomes `{status:"degraded", db:"down", …}`. `?deep` additionally runs a real query. Public, uncached, no secrets. That's the probe target.

> **Why 200 on failure (OPS-3, changed 2026-07-22 — it used to be 503).** On 2026-07-21 the control DB's compute quota ran out, this endpoint returned 503, Render pulled every instance from rotation and restart-looped the service, and *every* route 502'd — including static marketing pages that need no database. The liveness probe was reporting readiness, so a dependency outage became a total blackout. Now **liveness is the status code** (the process answered) and **readiness is the body**. The instance stays in rotation, marketing pages keep serving, and the jobs-drain cron stays reachable. A genuinely hung process still restarts — no response at all trips Render's own timeout.
>
> **Monitoring is unaffected:** alerting matches the keyword `ok`, which a degraded body does not contain, so a DB outage still pages. **Match on the KEYWORD, never on the status code** — a status-code-only monitor would now be blind to a DB outage.
>
> **Accepted tradeoff:** a fresh deploy with a wrong or missing `DATABASE_URL` now passes the health gate and rolls out serving degraded, where before it would have been held back. Availability over gatekeeping — if a deploy looks healthy but every API 500s, check `db` in the body first.

**Verify the degraded path** (no outage required):
`npx tsx --conditions react-server --env-file=.env scripts/verify-health-degraded.mjs`

## Public status page (external monitor — ~10 min)

Use a hosted monitor so the page survives a Render/Neon outage (a self-hosted status page is down exactly when you need it):

1. **Pick a monitor** — UptimeRobot (free: 50 monitors, 5-min checks, free status page) or BetterStack (nicer page, paid).
2. **Add two HTTP(S) monitors** — **KEYWORD monitors, not status-code monitors** (since OPS-3 the endpoint returns 200 even when the DB is down; a status-code monitor would never fire):
   - `https://pluggie.app/api/health` — keyword `"status":"ok"`, alert when **absent**.
   - `https://pluggie.app/api/health?deep` — keyword `"status":"ok"` (proves DB queryable), check every 5 min.
3. **Enable the hosted status page** the monitor provides; map it to `status.pluggie.app` via a **DNS-only (grey-cloud) CNAME** in Cloudflare to the monitor's target. Do **not** proxy it — it must resolve independently of your Cloudflare/Render path.
4. **Optional alerts:** email/SMS/Slack on `down` so you hear before customers do.

## Operator health widget (internal — already have the data)

For your own at-a-glance view, the operator console (`/admin/console`) already shows per-project stats; a small "platform health" panel reading recent `/api/health` + the Track 4c stats can be added when wanted (internal, fine to self-host — it's not the public trust surface).

## Future (product): per-tenant status

Each deployed tenant site's uptime as a customer-facing feature — parked until the platform page proves the pattern.
