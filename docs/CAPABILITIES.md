# Pluggie (AgentX) — System Capabilities

> **Living — last synced 2026-07-21.** What the platform can do **today**,
> grouped by surface. Sync this doc whenever a batch changes the tool surface
> or platform behavior (see CLAUDE.md ship ritual). For what's next, see
> [BACKLOG.md](BACKLOG.md) and [plans/POST-DEPLOYMENT-V2-PLAN.md](plans/POST-DEPLOYMENT-V2-PLAN.md);
> for implementation specs, see [gap-designs/](gap-designs/README.md). (The
> original phase roadmap lives in [archive/ROADMAP.md](archive/ROADMAP.md).)

Pluggie is an MCP-native backend platform: an agent defines a project's data
model over MCP and gets back a branded client admin, a public delivery API, and
declarative behaviors (authz, automation, payments, hooks, plugins) — without
Pluggie ever hosting tenant code. **57 MCP tools · 8 delivery endpoint
families · 554 smoke tests green (82 suites) · live at pluggie.app** (Render +
Cloudflare edge cache; public status page linked in the site footer).

---

## 1. Data modeling

- **10 field primitives** (closed vocabulary, [lib/field-types.ts](../lib/field-types.ts)):
  `text`, `richtext`, `number`, `boolean`, `date`, `enum`, `asset`, `relation`,
  `group` (fixed named sub-fields), `array` (repeater of a scalar/group/blocks).
- **Structured fields**: one-level nesting with recursive validation,
  projection, and write-gating; visual repeater editor in the admin. **Block
  types**: `define_block` maintains a project block library; an array field can
  hold heterogeneous named blocks, each validated against its shape (page-builder
  sections). Relations nest inside groups/blocks.
- **Constraints**: `required`, `unique` (partial-index backed), `min`/`max`,
  `integer`, `pattern` + `patternHint` (define-time safe-regex check),
  `requiredIf`, explicit unset via `null` (symmetric on create + update),
  `indexed` (expression index for hot filters; cleanly rejected on
  date/richtext/group/array), `searchable` (FTS surface).
- **Computed fields** (closed vocabulary): `slugify | template | now | uuid` —
  client values rejected, stamped server-side, recompute rules define-time
  checked (template composes into unique keys, e.g. no-double-book slots).
- **Localized fields**: `set_locales` + `localized: true` on text/richtext;
  variant maps stored, delivery serves one flat string (`?locale=`), MCP gets
  the raw map, per-variant fallback, wrap/delocalize migrations plan+confirm.
- **Schema evolution**: `define_collection` is full-replace with a live diff —
  destructive changes (dropped/retyped fields, **dropped workflow**,
  delocalize) return a **plan + confirm gate** read FRESH from the DB (never
  through cache); renames backfill atomically; tightening scans report
  `constraintWarnings[]`.
- **Structured errors everywhere**: `ConstraintIssue[]` + stable `E_*` codes —
  an agent repairs its own mistake from the error alone.

## 2. MCP tool surface (57 tools)

| Group | Tools |
|---|---|
| Project/meta | `get_project_info`, `list_field_types`, `list_connectors`, `get_client_code` |
| Schema | `define_collection`, `list_collections`, `describe_collection`, `delete_collection`, `set_locales` |
| Blocks | `define_block`, `list_blocks`, `delete_block` |
| Writes | `create_entry`, `update_entry`, `update_entry_if` (CAS), `delete_entry`, `bulk_create_entries`, `transact` |
| Reads | `query_entries`, `get_entry`, `count_entries`, `aggregate_entries`, `search_entries` |
| Safety net | `list_trash`, `restore_entry`, `purge_entry`, `empty_trash`, `list_entry_versions`, `restore_entry_version` |
| Assets | `upload_asset`, `list_assets`, `delete_asset` |
| Portability | `export_entries` (keyset cursor), `export_project`, `import_project` |
| Automation | `list_jobs`, `cancel_job`, `define_schedule`, `list_schedules`, `delete_schedule` |
| Inbound email | `configure_inbound`, `disable_inbound` |
| Plugins | `list_plugins`, `enable_plugin`, `disable_plugin`, `get_plugin`, `define_plugin`, `delete_plugin` |
| SEO (plugin-unlocked) | `score_page`, `audit_site`, `fetch_page` |
| Observability | `get_deliveries`, `refire_delivery`, `get_audit_log`, `get_changes` |
| Compute | `test_hook` |
| Platform | `send_feedback` (always available — agent-reported platform limitations land on the operator's console wall) |

- **Query power**: filters incl. `ne`/`exists`, one-level `anyOf` OR groups,
  sorting, keyset cursor paging, `select`, depth-1 `expand`, dotted related-field
  filters (parameterized EXISTS), `includeReverse`, aggregation
  (`count/sum/avg/min/max`, `groupBy` enum/relation with label resolution),
  full-text `search_entries` over `searchable` fields.
- **Atomicity**: `update_entry_if` = CAS + increment in one statement;
  `transact([ops])` = interactive multi-op transaction with cross-op `$ref`s,
  `dryRun`, idempotency receipts.
- **Idempotency keys** on writes; replays return original ids.
- **Read→write symmetry**: reads resolve asset/relation values to
  `{id, url|label, …}` objects — writes accept those objects back (coerced to
  the id), so loading an entry and saving it unchanged always round-trips.
- **Migration escape hatch**: `create_entry`/`bulk_create_entries` accept
  `allowExplicitWorkflowState: true` — historical records import at their real
  workflow states (any declared enum option); use is stamped into the audit
  actor. MCP-only; delivery and transact stay strict.

## 3. Delivery API (`/api/v1`, token-scoped, edge-cached)

- `GET /api/v1/{collection}` + `/{id}` — per-field `publicRead` projection,
  `publicFilter` row gate, filters/sort/paging/`select`/`expand`/related-field
  filters/`include` reverse embeds/`?q=` search/`?locale=`, strong ETags/304.
- **Writes**: `POST` (public or identity-gated), `PATCH`/`DELETE` under
  owner/claim rules, `POST /api/v1/{collection}/uploads` (multipart intake).
- `POST /api/v1/batch` — batch reads: several list queries in one POST,
  multiplexed over the real list handler (identical gates by construction).
- `GET /api/v1/changes?since=` + `/changes/stream` (SSE) — near-realtime feed.
- `POST /api/v1/checkout` — Stripe checkout from entry ids.
- `GET /api/v1/assets/{id}/image?w=&h=` — on-demand transforms.
- `GET /api/v1/_health` — public delivery-plane liveness probe (path can never
  collide with a collection; uptime monitors watch it).
- **Cloudflare edge cache** (live): worker keys cache by URL + SHA-256 of the
  bearer token (one slot per tenant per URL — no cross-tenant leaks), stores
  only origin-marked shareable responses (`s-maxage` on public reads), serves
  304s at the edge. `x-edge-cache: MISS-STORED → HIT` verified in prod.
- Every error is `{error, code}` from an append-only `E_*` registry; scope
  enforcement is mutual — an MCP token on delivery answers `E_SCOPE` with a
  mint-a-delivery-token hint (never a generic 401); rate limiting on public
  write/search/transform/checkout paths.
- **Gate freshness**: deny-shaped answers never come from cache alone — the
  create gate re-checks a fresh collection on deny (a just-relaxed
  access/publicWrite works immediately) and the auth gate re-checks a fresh
  connector before `E_CONNECTOR_REQUIRED` (a just-connected issuer works
  immediately). `publicWrite` coexists with `access.read` (anonymous
  submissions + gated reads); a non-none `access.write` replaces the anonymous
  path and `define_collection` says so (`accessNote`). The MCP surface
  caps at 300 tool calls/min/project — the throttle answers structured
  (`E_RATE_LIMITED` + `retryAfterSec` in `error.data` + a `Retry-After`
  header), never bare prose.
- `get_client_code` generates a typed, dependency-free TS client from the live
  schema (compile-verified under `--strict`).

## 4. Identity & authorization (fail-closed ladder)

- **BYO issuer**: per-project Clerk connector (JWKS probed on save), end-user
  JWTs via `X-User-Token`, multi-issuer, optional audience enforcement.
- **Presets, not expressions**: `read`/`write` accept
  `public | authenticated | owner | {claim, equals}` + any-of arrays. Owner rows
  via server-stamped `ownerField` (tamper-proof).
- **Org/team row scoping**: `access.org {claim, field}` — server-stamped,
  enforced as row clauses, cross-org label leaks gated.
- **Field-level writes**: `writableBy` per field (delivery surface).
- Per-field `publicRead` is the projection invariant no feature bypasses.

## 5. Automation: events, jobs, schedules, workflows, inbound

- **Events**: `entry.created/updated/deleted/transitioned` → webhook
  (HMAC-signed) or email (Resend) actions; `when` clauses, `{{field}}`
  interpolation, delivery log + re-fire; delayed actions (`after: "3d"`).
- **Jobs runner**: pg queue, `FOR UPDATE SKIP LOCKED` claim, drained by Render
  cron. **Recurring schedules**: UTC, CAS-advanced ticks.
- **Declarative scheduled mutations** (AUTO-1): a schedule action of
  `type: "mutate"` — where-select (relative `{daysAgo}` cutoffs resolved per
  tick) → CAS guard at write (changed rows skipped, never stomped) →
  workflow transition (mcp actor) + field stamps (closed vocabulary:
  now / null / literal / copyFrom). 200 rows/tick bound; audit rows carry the
  schedule name; idempotent re-runs. The CRM recycle sweep now self-hosts —
  no external compute required.
- **Declarative state machines**: `collections.workflow` — enum transitions
  with actor gates + per-transition actions, enforced at the entries choke
  point on every write path; dropping a workflow on redefine requires
  `confirm:true`; import escape hatch is audit-stamped (§2).
- **Inbound email → collection**: `configure_inbound` routes a secret-gated
  inbound address into a collection (trusted `{type:"inbound"}` audit actor).
- **Styled HTML email engine** shipped (branded templates for action emails);
  template-management UI not yet built.

## 6. Payments (Stripe)

- **Tenant checkout** (BYO Stripe connector, AES-GCM keys): declarative
  `collections.checkout`, server-side price lookup, signed webhook ingestion →
  order lifecycle CAS flips → fulfillment via events. One-time payments only
  (tenant subscriptions = BILL-1 in the backlog).
- **Platform billing** (Pluggie charging tenants): subscription checkout
  ($19/$29 tiers), Stripe Billing Portal self-serve, **metered usage rails**
  (usage-based line items) — metering stays INERT until toggled in Platform
  Settings.

## 7. Realtime (near-realtime pull, documented-lossy)

- Append-only `entry_changes` written at every mutation path with write-time
  visibility capture; delivery gating is then-AND-now; tombstones for
  visible→hidden. `GET /changes` (ETag/304) + SSE stream with resume. Worst-case
  lag ~2–4s.

## 8. Media

- R2-backed assets, MCP upload + public multipart intake, media admin page.
- `upload_asset` takes inline base64 **or a `url` fetched server-side**
  (SSRF-hardened: https-only, private/metadata ranges refused, redirect hops
  re-validated, 10MB bound) — image seeding without burning ~70k tokens per
  image on inline bytes.
- On-demand image transforms: sharp + R2-cached derivatives, size ladder,
  magic-byte sniff, derivative budget + rate limits.

## 9. BYO compute (hooks) — the "no hosted code" boundary

- **Before-write hooks**: HMAC-signed sync POST of the candidate to a tenant
  endpoint (validate/transform), enforced at the entries choke point (single,
  bulk per-item, transact); a hook can never move ownership; transform output
  fully re-validated. `test_hook` dry-run; `hook.*` delivery-log rows.
- Composition guide: hooks = sync gate, events = async, computed = derived;
  business logic composes on tenant infra — Pluggie never executes tenant code.

## 10. Plugins (one installable unit)

- A **PluginDef** = structure (baseline content model the agent reconciles via
  `define_collection`) + tools (MCP verbs it unlocks) + guidance + acceptance.
- **Session briefing** (Track C): `get_project_info` opens every session with
  `briefing` — plugin update OFFERS (acknowledged-at-enable version vs the
  catalog; adopting = reconcile through the gates, then `enable_plugin` again
  to acknowledge; nothing auto-applies), platform notices shown once per
  project, connector/delivery health, and an `attention` do-first list
  (major bumps, attention notices, erroring connectors).
- **Composition core** (Plugin Bases Plan, Track A): defs declare `provides`
  (the capability they own) and `requires` (dependencies). ONE active provider
  per capability, enforced on NEW enables only (grandfathered projects keep
  pre-existing overlaps); conflicting enables answer `E_CONFLICT` with an
  explicit `swap:true` path; unmet `requires` auto-enable the sole catalog
  provider (ambiguity asks you to choose); disabling a provider warns which
  enabled plugins lose their dependency. Store + `list_plugins` surface it all.
- **Two delivery mechanisms**: built-in (compiled: `seo`, `contact_forms`) and
  **DB-backed** (`plugin_defs` — global first-party defs seeded by the
  operator, or project-private defs authored at runtime via `define_plugin`).
  Effective catalog = built-ins + global + own, with operator overrides.
- **SEO plugin**: enables `score_page`/`audit_site`/`fetch_page` advisors.
- **Client case study**: `countryside_crm` (global DB def) — CRM baseline with
  workflow pipeline, owner relations, computed-unique slot keys.
- **Auth Kit** (`auth_kit`, global DB def) — DIY user management, credential-free
  by design: users with an account-lifecycle workflow (invited → active ↔
  suspended → deactivated, suspension admin-gated), roles + permissions registry
  (RBAC keys the tenant's token issuer embeds as claims), orgs/memberships with
  DB-enforced one-per-user+org, uuid-coded single-use invitations, and an
  `auth_events` security trail. Credentials (password hashes, sessions, MFA)
  stay on the tenant's own auth service — never in a collection.
- **Notification Kit** (`notification_kit`, global DB def) — in-app
  notifications for the tenant's app users (pairs with auth_kit): per-user feed
  with unread tracking (`read_at exists:false` badge query), idempotent sends
  via partial-unique `dedupe_key`, per-topic mute preferences (computed-unique
  pref rows), and workflow-governed broadcast announcements (draft → published,
  publish gated to mcp/admin). Realtime rides the changes feed/SSE — the
  platform's own realtime surface is the push channel.
- **Wave-1 bases** (each owns ONE capability, born with `provides`):
  `booking` (no-double-book slots + AUTO-1 hold expiry), `waitlist` (public
  signups → uuid invites), `feedback_wall` (client-facing feedback triage —
  the FEED-2 mirror of our own wall), `media_gallery` (publishable albums,
  publicFilter-gated, seeded via upload-by-URL). All four enable together
  conflict-free. Full base ideation: PLUGIN-BASE-CATALOG.md.
- **Store**: per-project Plugins tab (enable/disable, price chips, capability
  badges); operator console manages fleet activation + display pricing
  (`pluginOverrides`). Billing enforcement deliberately not wired yet.

## 11. Safety, observability, portability

- **Trash** (30-day sweep) → restore; purge/empty are plan + confirm.
- **Version history**: pre-image snapshots (cap 20/entry), restore validated.
- **Audit log** on every mutation, actor-typed from all surfaces (incl.
  `explicitWorkflowState` import stamps and `inbound`).
- **Export/import**: `export_entries` pages a keyset cursor to a complete exact
  export (console download walks it server-side); full project manifest
  round-trip; workflow-state import via the audit-stamped escape hatch.
- **Feedback wall**: `send_feedback` (always-on core tool) → operator console
  wall with status pipeline, filters, bulk-resolve. **Guarded ingest**: bug
  reports require receipts (`evidence` {request, verbatim response} — refused
  with a fix-forward hint otherwise), and every report is stamped with
  deterministic verification (claimed `E_*` codes checked against the
  registry, toolName against the tool surface, platform commit +
  enabled-plugin versions) rendered as badges on the wall — invented claims
  are visible on sight; the reproduction still decides what's true. First
  triage produced 5 shipped fixes + 1 security fix (see
  reviews/FEEDBACK-TRIAGE-2026-07.md); the wall has since driven 8 more.

## 12. Admin & console

Branded, Clerk-gated. **Per-project**: entry CRUD (TipTap richtext, relation
typeahead, transition-aware workflow fields, repeater/block editors), version
history, Trash, Media, Plugins store, Usage card, Connectors (health dots),
API reference, Settings (tokens, webhooks, members, billing). **Operator
console** (`/admin/console`): project fleet, Platform Settings (caps + metered
rates), plugin management, feedback wall. Design system: futuristic/technical
rebrand (see DESIGN-BRIEF.md).

## 13. Platform & data plane

- **Stack**: Next.js + Drizzle + Neon + Clerk + R2 + Stripe + Tailwind v4.
- **Tiered data plane**: shared control DB (free tier) · **managed Neon
  project per tenant** (provisioned via API, soft-delete recoverable 7 days) ·
  **BYO database** connector. `tenantDb(projectId)` resolves the plane;
  migrate-before-first-use gate with cold-start retry + connector self-heal.
- **Caps & metering**: sandbox caps (collections/entries/data bytes), per-project
  usage stats + Neon usage pull, Platform Settings editable in UI, metered
  billing rails (inert until enabled).
- **Ops**: Render blueprint deploy (push-master), Cloudflare CDN, health probes
  (`/api/health` process+DB, `/api/v1/_health` delivery), UptimeRobot keyword
  monitors + public status page (linked in the site footer). See OPS.md +
  runbooks/.
- **Verification culture**: `npm run verify` = tsc + live smoke run (554 tests,
  82 suites) against a real dev server.

## Not built (deliberate — with pointers)

- Date-bucketed aggregates + second groupBy dimension (top of triage Track B)
- Declarative scheduled data mutations; per-role workflow actors; enum option
  renames; SMS connector; capacity constraints (triage Tracks C/F)
- Tenant subscription commerce (BILL-1) · delivery-surface bulk writes (WP-7)
- Semantic/locale-aware search · per-row sharing ACLs
- Feedback issues-layer automation (designed, **on hold** — manual triage first)
- Hosted/sandboxed tenant code · raw SQL · rule expression language
  (**rejected**, not deferred)

Full pipeline: [BACKLOG.md](BACKLOG.md) ·
[reviews/FEEDBACK-TRIAGE-2026-07.md](reviews/FEEDBACK-TRIAGE-2026-07.md)
