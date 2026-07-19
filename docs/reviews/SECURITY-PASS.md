# C4 Security Pass — 2026-07-11

Scope per LAUNCH-PLAN C4: control-plane isolation, token hygiene (roadmap
2.5), secret rotation, `createProject` hardening — plus an authz sweep of
every server action and the outbound-fetch surfaces. Method: full read of the
authz choke points and outbound paths; a 37-action authorization sweep
(gate-before-mutation + resource scoping per action); live-DB token inventory;
guard behavior exercised under production env settings.

## Findings → fixed in this pass

1. **SSRF in tenant-controlled outbound fetches (moderate).** Webhooks
   (`lib/webhook.ts`), write hooks (`lib/hooks.ts`), event actions, and
   schedule fires POST to tenant-supplied URLs from our network, and the
   delivery log echoes HTTP status codes — a blind port-scanner into loopback,
   private ranges, and link-local metadata. **Fix:** `lib/net-guard.ts` —
   fire-time refusal of non-http(s) schemes, embedded credentials,
   localhost/.internal/.local hostnames, and private/loopback/link-local/CGNAT
   /multicast IPs (literal or DNS-resolved), wired into both fire paths;
   save-time shape check on the admin webhook form. Production-only (dev and
   the smoke suite target 127.0.0.1 receivers by design); operator escape
   hatch `ALLOW_PRIVATE_WEBHOOK_TARGETS=1`. Verified: 15/15 probe matrix.
   **Accepted residual:** DNS rebinding between our lookup and fetch's own
   resolution — the full mitigation is a pinned-IP undici dispatcher;
   post-launch if warranted.

2. **`refireDeliveryAction` accepted the client role (low).** Every other
   settings mutation is operator-gated; this one let a content-only share
   replay webhook/email deliveries (duplicate POSTs/emails to tenant
   endpoints; no cross-tenant reach — the delivery id was already
   project-scoped). **Fix:** `requireOperator` like its siblings.

3. **One-sandbox-per-workspace was raceable (low).** Count-then-insert in
   `createProject` — concurrent requests could mint two free sandboxes.
   **Fix:** partial unique index `projects_one_sandbox_per_ws_idx`
   (`ON projects (workspace_id) WHERE plan='sandbox'`), applied to the live
   DB; the action catches the violation and returns the friendly error.

## Verified sound (no change needed)

- **Authorization sweep:** 37 exported server actions audited — every one
  gates before mutating, and every row-id mutation is scoped to the authorized
  project/workspace (content rows via project-owned `collection.id`; workspace
  membership via caller's role in THAT workspace; owners unremovable;
  `deleteProject` on the stricter owner/admin gate with type-the-name
  confirm). Sole deviation was finding #2.
- **Token model (2.5):** SHA-256-hashed at rest, raw shown once, scope-checked
  (mcp vs delivery), suspended/canceled/setup projects fail closed at the
  boundary, 5-min cache TTL + revalidation on revoke/status change. Live
  inventory: 23 tokens, none stale-unused; the only production-load-bearing
  token is the marketing intake delivery token (rotate = mint new + swap
  Render `MARKETING_INTAKE_TOKEN` + revoke old — that pairing is the
  documented handoff flow).
- **Secrets:** AES-256-GCM keyed envelopes (v2.kid), fail-closed decrypt on
  unknown kid, rotation runbook + `needsReencrypt` sweep in `lib/crypto.ts`;
  secrets never serialized to MCP/browser/exports (manifest export carries
  definitions only, and the export route is operator-gated).
- **Unauthenticated surfaces:** platform-Stripe webhook signature-verified
  fail-closed (unset secret rejects everything); tenant Stripe webhook
  likewise per-project; jobs drain fail-closed on CRON_SECRET (min length +
  constant-time compare); delivery API token-gated with per-field publicRead
  filtering; rate limits durable (C2). Clerk middleware protects exactly
  `/admin(.*)`; token/signature-authed API routes are excluded on purpose
  (`/api/platform-stripe` passes through the middleware unprotected-by-Clerk
  and relies on its signature check — correct).
- **Isolation:** control-plane queries are projectId/workspace-scoped at the
  two choke points (`getProjectRole`, `accessibleProjects`); tenant-DB
  resolution fails closed (quarantine on migrate-gate failure); the smoke
  suite's cross-tenant isolation checks (49/50) are the standing regression.

## Also found in this pass (not a vuln)

- **Flaky schedule smoke test** (`25-schedules`, ~1/8) — surfaced while
  re-running the suite. Root cause: a `schedule_fire` job's `run_at` defaults
  to the app-server clock, but `claimDueJobs` compares against the Postgres
  clock; under small clock skew the just-enqueued job is briefly "not due", so
  the test's two concurrent drains occasionally both miss it. Harmless in
  production (the minute-ly cron drain claims it on the next tick, ≤60s).
  Fixed the test to re-drain while waiting (mirrors production); 10/10 stable
  after. No product change — the ≤60s worst-case latency on an immediately-due
  job is acceptable for schedules/delayed events.

## Accepted for launch (recorded)

- SSE change-stream concurrency brake is in-process (5/project/instance) —
  fine on single-instance Render; revisit if we scale out.
- Rate limiter fails OPEN on control-DB errors (capacity gate, not authz).
- `ADMIN_EMAILS` operator gate trusts Clerk's primary email — **operator
  action:** ensure the production Clerk instance requires email verification
  (it's the default; confirm when standing up pluggie.app Clerk).

## Operator follow-ups

- Two orphaned smoke-suite projects (`smoke a6delivery…`, `smoke
  cas-transition…`) hold unused tokens — delete from the console (or they go
  with the pre-launch test-project sweep). Automated cleanup was intentionally
  not run against the shared DB.
- Pre-launch: sweep the operator-era test projects (Andra 24, Codex, Comp
  Test, Currents Demo, Easel&Coin, Havn, Hilo, Tidewater, Vendor Hub,
  investigate, test 2) per the greenfield decision — your call under C1/C7.
- When Clerk production lands: confirm email verification + set
  `ALLOW_PRIVATE_WEBHOOK_TARGETS` UNSET in Render (guard active).
