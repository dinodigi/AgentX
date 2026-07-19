# AgentX — System Capabilities

> Snapshot as of 2026-07-09 (post Phase 16). What the platform can do **today**,
> grouped by surface. For what's next, see [BACKLOG.md](BACKLOG.md) and
> [plans/POST-DEPLOYMENT-V2-PLAN.md](plans/POST-DEPLOYMENT-V2-PLAN.md); for
> implementation specs, see [gap-designs/](gap-designs/README.md). (The original
> phase roadmap lives in [archive/ROADMAP.md](archive/ROADMAP.md).)

AgentX is an MCP-native backend platform: an agent defines a project's data
model over MCP and gets back a branded client admin, a public delivery API, and
declarative behaviors (authz, automation, payments, hooks) — without AgentX ever
hosting tenant code. **41 MCP tools · 7 delivery endpoint families · 366 smoke
tests green · deployed on Render** (same Neon DB as dev; dogfood posture).

---

## 1. Data modeling

- **8 field primitives** (closed vocabulary, [lib/field-types.ts](../lib/field-types.ts)):
  `text`, `richtext`, `number`, `boolean`, `date`, `enum`, `asset`, `relation`.
- **Constraints**: `required`, `unique` (text/number/date, partial-index backed),
  `min`/`max` (numbers, text length, date bounds), `integer`, `pattern` +
  `patternHint` (define-time safe-regex check — nested-quantifier patterns
  rejected, so runtime matching is provably bounded), `requiredIf {field, equals}`
  (create-only), explicit unset via `null`.
- **Computed fields** (closed vocabulary): `slugify | template | now | uuid`.
  Client-supplied values rejected at input, stamped server-side on create,
  recomputed on update when a source field changes (`now` supports
  `on:'always'`); frozen otherwise. Define-time cycle/chain rules.
- **Localized fields** (Phase 18): `set_locales {default, supported}` registers
  the project's locales; `localized: true` on text/richtext stores strict
  `{locale: value}` variant maps. Delivery serves ONE flat string (default or
  `?locale=`); MCP reads return the raw map; updates merge per locale. Barred
  from unique/searchable/computed/labelField/email templates/filters. Toggling
  a populated field: localize = wrap-backfill; delocalize = plan + confirm.
- **Schema evolution**: `define_collection` diffs against the live schema and
  returns a **plan + confirm** for destructive changes; field renames backfill
  atomically (including trash); define-time tightening scans report
  `constraintWarnings[]` against existing rows.
- **Structured errors everywhere**: every validation failure carries
  `ConstraintIssue[]` (field, constraint, limit/allowed/pattern, hint) and an
  `E_*` code — an agent can repair its own mistake from the error alone.

## 2. MCP tool surface (41 tools)

| Group | Tools |
|---|---|
| Project/meta | `get_project_info`, `list_field_types`, `list_connectors`, `get_client_code` |
| Schema | `define_collection`, `list_collections`, `describe_collection`, `delete_collection` |
| Writes | `create_entry`, `update_entry`, `update_entry_if` (CAS), `delete_entry`, `bulk_create_entries`, `transact` |
| Reads | `query_entries`, `get_entry`, `count_entries`, `aggregate_entries`, `search_entries` |
| Safety net | `list_trash`, `restore_entry`, `purge_entry`, `empty_trash`, `list_entry_versions`, `restore_entry_version` |
| Assets | `upload_asset`, `list_assets`, `delete_asset` |
| Portability | `export_entries`, `export_project`, `import_project` (manifest round-trip) |
| Automation | `list_jobs`, `cancel_job`, `define_schedule`, `list_schedules`, `delete_schedule` |
| Observability | `get_deliveries`, `refire_delivery`, `get_audit_log`, `get_changes` |
| Compute | `test_hook` (dry-run a hook without writing) |

- **Query power**: filters (`eq/in/...`), one-level `anyOf` OR groups, sorting,
  keyset cursor paging, `select:[fields]`, depth-1 relation `expand`,
  dotted-path related-field filters (`author.name eq X` → parameterized EXISTS),
  `includeReverse` (children-of-parent with exact per-parent `hasMore`),
  aggregation (`count/sum/avg/min/max`, `groupBy` with label resolution).
- **Atomicity**: `update_entry_if` = CAS + increment in one statement with
  SQL-faithful conflict diagnosis; `transact([ops])` = interactive multi-op
  transaction (MCP-only) with cross-op `$ref`s, `update_if` ops, `dryRun` plan
  mode, and batch idempotency receipts.
- **Idempotency keys** on writes; replays return original ids.

## 3. Delivery API (`/v1`, token- or public-scoped)

- `GET /v1/{collection}` + `GET /v1/{collection}/{id}` — per-field `publicRead`
  projection, `publicFilter` row gate, filters/sort/paging/`?select=`,
  `?expand=` (target shown exactly as a direct GET would), `?author.name=X`
  related-field filters with full target row gates, `?include=` reverse embeds,
  `?q=` keyword search (public-searchable subset, GIN-indexed), `?locale=`
  (localized fields, per-variant fallback to default), strong ETags/304.
- **Writes**: `POST` (public or identity-gated), `PATCH`/`DELETE` under owner/
  claim rules, `POST /v1/{collection}/uploads` (multipart public upload intake).
- `GET /v1/changes?since=` + `GET /v1/changes/stream` (SSE) — near-realtime
  change feed with then-AND-now privacy gating (see §7).
- `POST /v1/checkout` — Stripe checkout from a cart of entry ids (see §6).
- `GET /v1/assets/{id}/image?w=&h=&fit=&format=` — on-demand image transforms
  (see §8).
- Every error is `{error, code}` from an append-only `E_*` registry; rate
  limiting on public write/search/transform/checkout paths.
- `get_client_code` generates a **typed, dependency-free TS client** from the
  live schema (compile-verified under `--strict`): CRUD, search, uploads,
  changes poll/stream, checkout, hook-endpoint stub.

## 4. Identity & authorization (fail-closed ladder)

- **BYO issuer**: per-project Clerk connector (JWKS probed on save, one-paste
  publishable-key setup), end-user JWTs via `X-User-Token`, multi-issuer
  support, optional audience enforcement.
- **Presets, not expressions**: `read`/`write` accept
  `public | authenticated | owner | {claim, equals}` and **any-of arrays**
  (`write: ["owner", {claim:"role", equals:"moderator"}]`). Owner rows via
  server-stamped `ownerField` (tamper-proof — stripped on PATCH and on the
  anonymous path).
- **Org/team row scoping**: `access.org {claim, field}` — server-stamped,
  enforced as row clauses on every operation, cross-org label leaks gated.
- **Field-level writes**: `writableBy: "none" | ClaimRule` per field (delivery
  surface; admin/MCP unaffected).
- Per-field `publicRead` is the read-projection invariant **no feature bypasses**
  (this is why there is no raw SQL escape hatch).

## 5. Automation: events, jobs, schedules, workflows

- **Events**: `entry.created/updated/deleted/transitioned` → webhook (HMAC-signed,
  `t=…,v1=…`) or email (Resend connector) actions; `when:[clauses]` matching,
  `{{field}}` interpolation, `disabled` pause, delivery log + re-fire.
- **Delayed actions**: `after: "3d"` (1m..365d) — payloads are references +
  `actionHash`; config re-resolved at run time (edited/disabled → skip,
  `when` re-checked against the current entry).
- **Jobs runner**: pg `jobs` table, single-statement `FOR UPDATE SKIP LOCKED`
  claim (proven race-free on neon-http), drained by a hardened
  `POST /api/jobs/drain` hit by Render cron.
- **Recurring schedules**: `project_schedules` (UTC), CAS-advanced ticks proven
  under concurrent drains.
- **Declarative state machines**: `collections.workflow` — enum-field
  transitions with actor gates and per-transition actions; enforced at the
  entries choke point on every write path; CAS transitions proven exactly-once
  under 5-way races.
- Admin **Automation** panel: schedules pause/resume, job cancel, transition-aware
  entry forms.

## 6. Payments (Stripe, one-time checkout)

- Stripe as a **BYO connector** (keys AES-GCM encrypted, never exposed over MCP;
  pinned API version; no SDK).
- Declarative `collections.checkout` (`{priceField, successUrl, cancelUrl}`) —
  sellable ⇒ public, re-checked on every write.
- `POST /v1/checkout`: server-side price lookup (client amounts never trusted) →
  Stripe Checkout Session; pending-order-first.
- Signed webhook ingestion (`whsec` signature is the only auth; multi-key
  rotation, replay bound, body cap) → **order lifecycle** paid/expired CAS flips
  → declarative fulfillment via existing events.
- One-click webhook provisioning from the admin card; checkout snippet in the
  generated client.

## 7. Realtime (near-realtime pull, documented-lossy)

- Append-only `entry_changes` feed written at **every** mutation path (create/
  update/CAS/delete/bulk/transact/restore/collection-delete tombstones), with
  write-time visibility capture.
- Delivery gating is **then-AND-now**: a change is served only if the snapshot
  passed both write-time and current rules; visible→hidden becomes a tombstone;
  never-visible activity is suppressed.
- `GET /v1/changes` (ETag/304) + SSE stream (bounded lifetime, long-poll
  degrade, resume via `Last-Event-ID`, per-project stream cap). Worst-case lag
  ~2–4s; sync clients periodically reconcile with a full list GET.

## 8. Media

- R2-backed assets: MCP upload + public multipart intake, media admin page.
- **On-demand image transforms**: `?w=&h=&fit=&format=` → sharp + R2-cached
  derivatives, 12-value size ladder, webp/jpeg, 1-yr-immutable 302s.
  Magic-byte content sniff (SVG/non-raster refused), derivative budget + rate
  limits, derivatives prefix-deleted with the asset.

## 9. BYO compute (hooks) — the "no hosted code" boundary

- **Before-write hooks**: HMAC-signed sync POST of the candidate entry to a
  tenant endpoint (`beforeCreate`/`beforeUpdate`; validate or transform mode;
  https-only except loopback; strict timeout; fail-open/closed per config).
  Enforced at the entries choke point: single, bulk (bounded per-item
  concurrency), and transact creates. A hook can never move ownership
  (identity re-stamped/re-stripped server-side); transform output is fully
  re-validated.
- `test_hook` dry-run tool; `hook.*` rows in the delivery log.
- **Composition guide** in the tool surface: hooks = sync gate/transform,
  events = async, computed = derived, write-back via idempotencyKey/CAS.
  Full business logic composes on the tenant's infra — AgentX never executes
  tenant code.

## 10. Safety, observability, portability

- **Trash** (30-day sweep) → `restore_entry`; purge/empty are plan + confirm
  with inbound-ref and asset disclosure.
- **Version history**: pre-image snapshots on every update path (cap 20/entry),
  one-click restore through full validation (itself undoable).
- **Audit log** on every mutation with actor from all three surfaces; entry
  History panel in the admin.
- **Export/import**: entries export + full project manifest round-trip (hooks
  without signing secrets import disabled + warned).
- Webhook delivery log is a multi-shape ledger (`email:*`, `hook.*`,
  `stripe:*`, schedule fires) with per-shape refire guards.

## 11. Admin (client handoff artifact)

Branded, Clerk-gated, per-project: entry CRUD with TipTap richtext, relation
typeahead, transition-aware workflow fields, read-only computed fields, version
history + restore, Trash page, Media page, inbox with unhandled badges,
Appearance (branding), Connectors (health dots, rotate-key), API reference,
Settings (tokens, webhooks, members, manifest, delivery log, Automation).
Design system: "paper-and-ink editorial" (shared CSS vocabulary in globals.css).

## 12. Platform & ops

- **Stack**: Next.js + Drizzle + Neon + Clerk + R2 + Tailwind v4; MCP server
  scoped per-project by `agx_` bearer token; scoped tokens.
- **Connectors** (BYO infra): Clerk (auth), Resend (email), Stripe (payments) —
  AES-GCM secrets, health checks, validated rotation. Neon connector = Phase 19.
- **Deployed on Render** (`render.yaml` Blueprint; push-to-master auto-deploys;
  jobs drain via Render cron). Host-agnostic mechanisms throughout (pg queues,
  HTTP-only streaming).
- **Verification culture**: `npm run verify` = tsc + 43-suite live smoke run
  (366 tests) against a real dev server; every increment lands with a targeted
  smoke + adversarial review on risky ones.

## Not built (deliberate — with revisit triggers)

- Semantic/hybrid search (Phase 14 — gated on dogfood FTS evidence)
- Locale-aware search — localized × searchable is barred until search
  understands locales (the E×J conflict; needs a multilingual site asking)
- Per-row sharing ACLs (F5 — design recorded, needs a real ask)
- Delivery-surface `transact` · subscriptions/refunds (tenant app layer)
- Hosted/sandboxed tenant code · raw SQL · hosted email · rule expression
  language (**rejected**, not deferred)
- BYO database (Phase 19), multi-tenancy (20), plugins (21)
