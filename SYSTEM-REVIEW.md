# AgentX System Review — refreshed 2026-07-05 (evening)

Grounded audit after the subsystem sweep: ~8.9k source lines + 2.3k test
lines · **26 MCP tools · 93 automated integration tests** (`npm run verify`,
green before every commit) · 8 tables. The morning review's Round A and
Round B are complete; what remains is Round C — proving it in the field.

## Part 1 — Subsystem states (work order 01→10)

### 01 Ops & quality — A- (was D)
93-test suite, ephemeral projects, pre-commit gate, data export + backup
runbook, after()-deferred side-work, pluggable rate-limit store.
**Gated:** CI, usage metering (platform), durable store impl (deploy).

### 02 Security — A-
HMAC webhooks, CORS (+expose-headers), upload limits, audit trail on all
three surfaces, security headers, token last-used. **Gated:** content-scope
token (custom-admin demand), strict CSP (Clerk allowlist work).

### 03 MCP surface — A
Stable `E_*` codes with fix hints, exact pagination envelopes, get_deliveries
/ get_audit_log / refire_delivery self-debugging, get_client_code (typed
dependency-free TS client, tsc --strict + live round-trip tested).

### 04 Query layer — A-
eq/contains/gt/lt/in + anyOf OR groups, select projection, exact keyset
cursors, aggregate_entries (count/sum/avg/min/max, group-by enum/relation
with labels). **Deferred:** relation depth (real-site evidence).

### 05 Data layer — A
Constraints (unique via partial indexes, min/max, requiredIf),
update_entry_if (atomic CAS + guarded increment — 5 parallel bookings vs 3
seats: exactly 3 win), rename migrations with backfill.
**Gated:** multi-relation, transact (evidence).

### 06 Delivery API — A-
{error, code} envelope, strong ETags + 304s, public multipart uploads,
versioning discipline doc. A CDN-hosted static site needs no server of its
own. **Deferred:** presigned-PUT uploads (volume), per-project CORS allowlist.

### 07 Admin — A- (pending human eyeball)
TipTap richtext, inbox mark-handled + badges, Media page, typeahead relation
picker, entry History panel, mobile drawer, teaching empty states. Clerk-gated
so the suite can't render it — **visual pass before next client handoff.**

### 08 Events — A-
when: clauses, disabled flag, previous+changedFields snapshots, re-fire from
the log (tool + button; email renders stored for replay).
**Gated:** digests (demand), function actions (Phase 6).

### 09 Identity — B+ (mechanically proven, not field-proven)
Multi-issuer + audience + clock tolerance, session guidance doc, owner rules,
stamping. **The gap is a real Clerk instance** — everything verified against
a mock RS256 issuer only.

### 10 Connectors — B+
Rotation with validate-before-swap, studio health dots, encrypted secrets,
health probes. **Gated:** scheduled checks (deploy), OAuth flows (platform),
Neon (tenant), provider expansion (demand).

## Part 2 — Round C: prove it (unchanged, all needs the user)

- [ ] C1 Real Clerk + Resend connected, live end-to-end auth + email
- [ ] C2 Deploy — prod env; durable RateLimitStore impl; after() already in place
- [ ] C3 Real client site + friction log (THE milestone — decides every gate)
- [ ] C4 Close the Tidewater experiment file (scores/times)
- [ ] C5 Human visual pass on the admin (TipTap, combobox, mobile, Media, rotate)

## Historical record

The original 2026-07-05 morning review (grades D–A-, Round A/B gap lists) is
in git history at commit 07e40ed and earlier — kept out of this file so the
review always describes the system as it is.
