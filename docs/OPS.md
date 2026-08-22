# Ops runbook (C5)

> **Living — last synced 2026-08-21.**

What's wired in code vs. what the operator sets up in a console. Launch gate
C5 = the operator items below are done; the code items already shipped.

## Health & readiness — ✅ in code

**This section described the OPPOSITE behaviour until 2026-08-21, and the
behaviour it described is the one that caused a total outage.** Read the note
below before changing anything here.

- `GET /api/health` → **always 200 while the process is alive.** Readiness is in
  the BODY: `{status:"ok",db:"up"}` normally, `{status:"degraded",db:"down"}`
  when the control DB does not answer. `?deep` also counts a table, so a
  connected-but-empty pool still has to prove it can query.
- `GET /api/v1/_health` → 200 `{status:"ok",surface:"delivery"}` — public
  delivery-plane liveness probe (collision-proof path; folder is `%5Fhealth`).
- `render.yaml` sets `healthCheckPath: /api/health`. Render is therefore asked
  to judge LIVENESS only. A genuinely hung process still restarts — no response
  at all trips Render's own timeout, which is the failure a health check should
  catch.
- The jobs-drain cron exits non-zero on a non-2xx tick, so a failing drain
  shows up as a failed cron run in Render.

**Why liveness and readiness are split (OPS-3).** On 2026-07-21 the control DB's
compute quota ran out, `/api/health` answered 503, Render pulled every instance
and restart-looped the service, and *every* route 502'd — including static
marketing pages that need no database at all. A dependency outage became a total
blackout because the liveness probe was reporting readiness.

Returning 200-with-degraded keeps the instance in rotation: static pages keep
serving, the drain cron stays reachable, and DB-backed routes fail honestly
per-request instead of being replaced by a restart loop.

Monitoring is unaffected — UptimeRobot matches the keyword `ok`, which the
degraded body does not contain, so a DB outage still pages.

Deliberate tradeoff: a deploy with a wrong or missing `DATABASE_URL` now passes
the gate and rolls out degraded, where before it would have been held back.
Availability over gatekeeping.

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

## Test database — ✅ in code (OPS-4)

The smoke suite runs against a **separate Neon project** (`pluggie-test`), not
the control plane. `npm run smoke` loads `.env.test` over `.env` to swap
`DATABASE_URL`; the matching dev server is `npm run dev:test` on port 3200.

Two consequences worth knowing:

- Before this existed, a ~600-test run hit the production control DB. That was a
  material share of the compute that exhausted the quota on 2026-07-21.
- The suite's stranded-fixture sweeper only runs DURING a smoke run, so it now
  only ever cleans the TEST database. 48 fixtures stranded in production before
  the split sat there until swept by hand on 2026-08-21
  (`scripts/sweep-stranded-fixtures.mjs`, which keeps its guards reviewable).

## Local development writes to PRODUCTION — ⚑ operator (known, not yet fixed)

`npm run dev` loads `.env` only, whose `DATABASE_URL` is the **production
control plane**. Local development therefore reads *and writes* real projects.
Use `npm run dev:test` when the work does not need real data.

This is ENV-1's actual point and it becomes blocking for the Clerk production
move: production and local would hold different Clerk user IDs while sharing one
`project_members` table, so re-keying to production IDs locks you out locally.

## Identity — ⚑ operator (production instance not yet created)

Production runs on a Clerk **development** instance (`sk_test_` keys). Verified
2026-08-21: a `project_members` row created through the live site resolves
against the local test key, and Clerk user IDs are instance-scoped.

Moving to a production instance requires your own Google OAuth credentials (dev
instances use Clerk's shared ones), DNS records, and a **re-key**: production
issues new user IDs, so every stored `clerk_user_id` must be remapped by email.
As of 2026-08-21 that is 11 distinct identities — 10 sign in with Google, 2 with
a password. The cost only grows with the user count.

## Tokens — ✅ in code (TOK-1)

Project tokens are SHA-256 hashed at rest, shown once, scoped (`mcp` vs
`delivery`), and revocable from Settings → Tokens or over MCP
(`mint_delivery_token` / `list_delivery_tokens` / `revoke_delivery_token`).
`readOnly: true` mints a browser-safe delivery token. Revoking a minting token
cascades to what it minted — enforced in the database, not in application code.

## Edge and origin — ⚑ operator (OPS-8 outstanding)

The rate limiter keys on `cf-connecting-ip`, which Cloudflare overwrites at the
edge, falling back to the LAST `x-forwarded-for` entry and then to a single
shared bucket (SEC-5, 2026-08-14 — the previous key was the leftmost forwarded
entry, which the caller supplies).

**Residual:** that only holds for traffic arriving THROUGH Cloudflare. A request
sent straight to the Render origin can still set either header, and also bypasses
the edge cache. Closing it is deployment-side — Authenticated Origin Pulls, or an
origin firewall allowing only Cloudflare ranges. Tracked as OPS-8.

## Secret rotation — ✅ runbook in code

`lib/crypto.ts` header documents connector-secret key rotation
(`CONNECTOR_MASTER_KEYS` + `CONNECTOR_MASTER_KEY_ACTIVE`, `needsReencrypt`
sweep). `MARKETING_INTAKE_TOKEN` rotation = mint a new delivery token on the
Pluggie Marketing project, swap it in Render, revoke the old one. See
`docs/reviews/SECURITY-PASS.md` for the token model.
