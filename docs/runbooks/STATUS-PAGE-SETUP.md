# Status / Uptime Page — setup (v2 Track 7)

**Goal:** a public, GitHub-style uptime page for pluggie.app that stays up **when your own infra is down** — so it must be hosted **off** your infra. This is operator config, not code: the signal already exists.

## The signal (already shipped)

`GET https://pluggie.app/api/health` returns `{status:"ok", db:"up", latencyMs}` (200), or `{status:"degraded", db:"down"}` (503) when the control DB is unreachable. `?deep` additionally runs a real query. Public, uncached, no secrets. That's the probe target.

## Public status page (external monitor — ~10 min)

Use a hosted monitor so the page survives a Render/Neon outage (a self-hosted status page is down exactly when you need it):

1. **Pick a monitor** — UptimeRobot (free: 50 monitors, 5-min checks, free status page) or BetterStack (nicer page, paid).
2. **Add two HTTP(S) monitors:**
   - `https://pluggie.app/api/health` — expect **200**, keyword `"status":"ok"`.
   - `https://pluggie.app/api/health?deep` — expect **200** (proves DB queryable), check every 5 min.
3. **Enable the hosted status page** the monitor provides; map it to `status.pluggie.app` via a **DNS-only (grey-cloud) CNAME** in Cloudflare to the monitor's target. Do **not** proxy it — it must resolve independently of your Cloudflare/Render path.
4. **Optional alerts:** email/SMS/Slack on `down` so you hear before customers do.

## Operator health widget (internal — already have the data)

For your own at-a-glance view, the operator console (`/admin/console`) already shows per-project stats; a small "platform health" panel reading recent `/api/health` + the Track 4c stats can be added when wanted (internal, fine to self-host — it's not the public trust surface).

## Future (product): per-tenant status

Each deployed tenant site's uptime as a customer-facing feature — parked until the platform page proves the pattern.
