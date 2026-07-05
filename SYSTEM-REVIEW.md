# AgentX System Review — 2026-07-05

Grounded audit: 6,174 lines / 57 source files · 19 MCP tools · 8 tables ·
verified by live batteries (no automated tests yet). Grades are honest.

## Part 1 — What exists, subsystem by subsystem

### Data layer — A-
8 primitives, strict runtime validation (unknown keys, types, enums, dangling
refs all rejected), schema diff/plan/confirm, manifest export/import,
idempotency keys, bulk create with per-item results.
**Missing:** field constraints (unique/min/max), multi-relation (has-many),
rename migrations (rename = drop+add today, data stranded).

### Query layer — B
eq/contains/gt/lt filters, typed sort, offset paging, filtered counts.
**Missing:** `in` + OR logic, aggregations (sum/avg/group-by), cursor
pagination, deep relation population (one level of {id,label} only).

### Delivery API — B+
Per-field publicRead, publicFilter row gates, identity gates, single-entry
GET/PATCH/DELETE for owners, rate-limited public POST.
**Missing:** CORS headers (browser calls will fail cross-origin), webhook HMAC
signatures, public file uploads (forms can't attach files), ETag/cache headers.

### Identity — B
BYO-issuer JWT verification (JWKS cached), public/authenticated/owner presets,
server-side owner stamping, ownership immutable via API.
**Missing:** claims-based roles (gated), a real Clerk instance actually
connected (verified against mock issuer only), JWT-only revocation caveat
(no server-side logout).

### Events — B-
created/updated/deleted → webhook (3 retries + log) and email (Resend,
{{field}} interpolation), single emit point covering MCP/admin/delivery.
**Missing:** conditional actions ("only when status=confirmed"), manual
re-fire for failed deliveries, agent-readable delivery log (admin-only today —
agents can't debug their own webhooks).

### Connectors — B-
Encrypted secrets (AES-256-GCM), Clerk + Resend, health checks, status via MCP
with secrets structurally unexposable.
**Missing:** Neon connector (gated on tenant demand), OAuth connect flows
(paste-keys only), secret rotation UX.

### Admin — B+
Registry-rendered, per-project branding, redesigned (paper/ink), tabs
(Appearance/Connectors/Settings/API), search + pagination, delivery log.
**Missing:** richtext is a bare textarea (weakest handoff moment), relation
picker caps at 500 options, no asset manager page, no audit log (who changed
what), no one-click mark-handled for inboxes, mobile layout untested (fixed
240px rail — likely poor).

### MCP surface — A-
19 self-describing tools, machine-readable errors with fix hints,
plan+confirm on destruction, get_project_info orientation.
**Missing:** `get_client_code` (generated typed TS client — both experiment
arms hand-rolled one), delivery-log reading tool, docs URL in errors.

### Security — B
Scoped tokens (mcp/delivery) + rotation + cache TTL, rate limiting, encrypted
secrets, per-project access with 404 shielding, reserved slugs.
**Missing:** audit trail, webhook signatures, CORS policy, hard upload
size/type limits, CSP headers.

### Ops & quality — D (the honest one)
Everything verified by hand-driven curl batteries; git history; memory notes.
**Missing:** automated tests (zero), CI, deploy (user-deferred), durable rate
limiting (in-memory), event emits are void promises (serverless risk: use
after()/queue when deployed), monitoring/alerting, data export/backup beyond
Neon defaults, usage metering.

## Part 2 — What "next level" means

From *working dogfood tool* to *credible platform someone else could rely on*.
Three pillars:

1. **Trustworthy under failure** — provable behavior (tests), recoverable data
   (export/backup), debuggable by its own agents (log tools).
2. **Complete for a first real app** — no wall in the first week of a real
   client build (SDK, uploads, aggregations, editor, constraints).
3. **Proven** — deployed, real Clerk/Resend connected, one real site shipped,
   friction log mined.

## Part 3 — The gap plan

### Round A — Trust (all local, no deploy)
- [x] A1 Automated smoke suite — ✅ 2026-07-05: 38 tests / 8 files, `npm run verify`
- [x] A2 Data export — ✅ 2026-07-05: export_entries tool + admin CSV/JSON + runbook
- [x] A3 Webhook HMAC signatures — ✅ 2026-07-05
- [x] A4 CORS policy on /v1 — ✅ 2026-07-05 (permissive; per-project allowlist later)
- [x] A5 `get_deliveries` tool — ✅ 2026-07-05 (subsystem 03, + get_audit_log)
- [x] A6 Light audit log — ✅ 2026-07-05 (write-only; UI in subsystem 07)

### Round B — First-app completeness
- [x] B1 `get_client_code` — ✅ 2026-07-05 (subsystem 03; tsc --strict + live round-trip tested)
- [ ] B2 Public uploads — size/type-limited upload path for publicWrite forms
- [ ] B3 Aggregations — sum/avg/min/max + group-by (number/enum fields)
- [ ] B4 Field constraints — unique/min/max (ladder rung 1)
- [ ] B5 `update_entry_if` — atomic compare-and-set (ladder rung 2)
- [ ] B6 Richtext editor in admin (TipTap) + inbox mark-handled
- [ ] B7 Mobile pass on the admin

### Round C — Prove it (needs user)
- [ ] C1 Real Clerk + Resend connected, live end-to-end auth + email
- [ ] C2 Deploy (whenever chosen) — prod env, durable rate limit note, after()/queue for emits
- [ ] C3 Real client site + friction log (THE milestone)
- [ ] C4 Close the Tidewater experiment file (scores/times)

### Stays gated (unchanged)
Claims roles · transact · hosted functions (architecture documented in chat
2026-07-05; build only at Phase 6) · Neon connector · realtime (decide on
evidence) · multi-relation (dogfood signal) · workspaces/quotas/plugins.
