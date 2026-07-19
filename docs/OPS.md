# Ops runbook (C5)

> **Living — last synced 2026-07-19.**

What's wired in code vs. what the operator sets up in a console. Launch gate
C5 = the operator items below are done; the code items already shipped.

## Health & readiness — ✅ in code

- `GET /api/health` → 200 `{status:"ok",db:"up"}` when the control DB answers,
  503 `{status:"degraded"}` otherwise. `?deep` also counts a table.
- `GET /api/v1/_health` → 200 `{status:"ok",surface:"delivery"}` — public
  delivery-plane liveness probe (collision-proof path; folder is `%5Fhealth`).
- `render.yaml` sets `healthCheckPath: /api/health` on the web service — Render
  restarts / de-rotates an instance whose DB dependency is down instead of
  letting it serve 500s.
- The jobs-drain cron exits non-zero on a non-2xx tick, so a failing drain
  shows up as a failed cron run in Render.

## Backups & PITR — ⚑ operator (Neon console)

- **Control-plane DB** (the shared Neon project, `DATABASE_URL`): confirm PITR
  history ≥ 7 days. Neon's paid plans retain history; verify the retention
  window on THIS project, not just the org default. This DB holds every
  workspace, project registry, token hash, connector secret (encrypted), and
  the usage/event tables — losing it is losing the platform.
- **Managed tenant DBs** (one Neon project per managed project, created via
  `NEON_API_KEY`): they inherit the org plan's retention. Note that our
  `deprovisionManagedDatabase` delete is recoverable for 7 days (Neon's
  soft-delete) — that's the accidental-teardown safety net.
- **BYO tenant DBs**: the tenant's own backups, explicitly not our
  responsibility (documented in the delete flow).
- **Restore drill** (C7): once before launch, branch the control DB to a
  point-in-time and confirm the app boots against the branch. Cheap insurance
  that PITR is actually usable, not just enabled.

## Monitoring & alerts — ⚑ operator (Render dashboard)

- Turn on Render's service health notifications (deploy failed, health check
  failing, instance restarted) → email/Slack.
- Add an alert on the `agentx-jobs-drain` cron failing — a silently dead drain
  means webhooks/schedules/usage-rollup stop, and nothing else surfaces it.
- ✅ **External uptime — DONE 2026-07-19** (UptimeRobot free plan): 3 keyword
  monitors — `/api/health` ("ok"), `/api/v1/_health` ("ok"), `/` ("Pluggie") —
  alerting partners@dinodigi.com on down+up; public status page
  https://stats.uptimerobot.com/YSeB4QyizR, linked in the site footer.
  Setup + free-plan gotchas (keyword monitors only — the HTTP-method field is
  paid): [runbooks/STATUS-PAGE-SETUP.md](runbooks/STATUS-PAGE-SETUP.md).

## Error tracking — ⚑ operator (choose a service)

Not wired to a provider yet — deliberately, since it needs an account + DSN.
Today errors go to `console.error` → Render logs (searchable, not alerting).
To add Sentry (recommended, lowest-friction with Next):

1. `npm i @sentry/nextjs`, run the wizard (creates `sentry.*.config.ts`).
2. Add `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` to `render.yaml` as
   `sync: false` env vars.
3. The many `console.error(...)` call sites (rate-limit fail-open, webhook
   guard refusals, health check, drain rollup, billing webhook) become
   breadcrumbs automatically; add `Sentry.captureException` at the few places
   we currently swallow (deferred audit writes) only if you want them tracked.

Small and self-contained — a post-launch fast-follow if you'd rather ship on
Render logs first. It does NOT block the launch gate; monitoring + backups do.

## Secret rotation — ✅ runbook in code

`lib/crypto.ts` header documents connector-secret key rotation
(`CONNECTOR_MASTER_KEYS` + `CONNECTOR_MASTER_KEY_ACTIVE`, `needsReencrypt`
sweep). `MARKETING_INTAKE_TOKEN` rotation = mint a new delivery token on the
Pluggie Marketing project, swap it in Render, revoke the old one. See
`docs/reviews/SECURITY-PASS.md` for the token model.
