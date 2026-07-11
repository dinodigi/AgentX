# Design: Per-project data plane (Track A / Phase 19)

> **Status:** A0 draft for review, 2026-07-10. No code. This is the design we
> argue with before the A1 refactor. Supersedes the "evidence-gated Neon
> connector" framing in ROADMAP Phase 19 — see [LAUNCH-PLAN.md](../LAUNCH-PLAN.md)
> Track A.

## 1. What we're building and why

Today every project's content lives in one shared Neon database, separated only
by a `project_id` column on every row. The launch model (free workspace, pay per
project, BYO-keys **or** managed infra) needs each project's **content** to live
in its **own database** — BYO (the tenant's Neon) or managed (a Neon DB we
provision in our org). That gives us: real data-ownership isolation, the
managed/BYO split as one mechanism, and — via Neon branching — the dev/prod
environments that fix today's env-mixing problem.

The greenfield premise (the shared DB is disposable — no meaningful data on it)
removes the hardest part of this normally-terrifying migration: **no backfill,
no dual-write, no legacy shared-tables mode.** We build the split cleanly and
every project is born into it.

### The four questions this doc answers

1. **Table split** — which tables move to the tenant DB vs stay control-plane.
2. **Resolver seam** — how every content query resolves a per-project connection.
3. **Migration runner** — installing + versioning the fixed table set across N
   tenant DBs forever.
4. **Provisioning flows** — BYO vs managed, and where dev/prod environments fit.

## 2. The central idea: control plane vs tenant data plane

Two kinds of database:

- **Control-plane DB** (one, shared — today's DB, shrunk): platform + tenant
  *identity, config, auth, billing, and coordination*. Small, bounded by the
  number of tenants, and the only place cross-project queries run.
- **Tenant data-plane DB** (one per project — BYO or managed): the project's
  *content and its tightly-coupled machinery*. High-volume, isolated, atomically
  self-contained for entry writes.

The dividing line is **atomicity**, not tidiness. A table goes to the tenant DB
if and only if it participates in an atomic operation with entry rows, OR it is
high-volume observability naturally co-located with that content. Everything
else — anything queried across projects, or that coordinates the platform —
stays control-plane. Postgres has no cross-database transactions or foreign
keys, so any FK or same-transaction write that would straddle the line forces a
decision.

## 3. The table split

Current schema is 15 tables ([db/schema.ts](../../db/schema.ts)). Classification:

| Table | Plane | Why |
|---|---|---|
| `projects` | **Control** | Tenant identity + config. Root of everything. |
| `project_members` | **Control** | Access control (→ workspaces in B1). |
| `project_tokens` | **Control** | Auth; resolved on every MCP/delivery request before any tenant query. |
| `project_connectors` | **Control** | BYO-infra config incl. the **neon connector** that names the tenant DB — must be readable to resolve the tenant connection. |
| `collections` | **Control** | The schema registry (config the AI composes). See §5 — the one genuinely hard call. |
| `jobs` | **Control** | One shared queue, one drain endpoint. Enqueued post-commit (not atomic with entry writes). See §6. |
| `project_schedules` | **Control** | Project-level recurrence, ticked by the shared drain alongside jobs. No entry coupling. |
| *workspaces, billing, usage* | **Control** | New in Track B; platform-level by definition. |
| `entries` | **Tenant** | The content. |
| `entries_trash` | **Tenant** | A delete is an atomic row-**move** from `entries` (same-DB CTE). |
| `entry_versions` | **Tenant** | Pre-image written alongside each update. |
| `entry_changes` | **Tenant** | Change feed read per-project by the delivery API; written post-commit (Class 2, §3) → route to the tenant DB. |
| `transact_receipts` | **Tenant** | Written as the **first statement inside** the entry-writing transaction. |
| `audit_log` | **Tenant** | One row per entry mutation; tenant-volume; loose `entryId`/`collectionName` (no FK). |
| `webhook_deliveries` | **Tenant** | Tenant-volume outcome log; loose refs; already `collectionId`-nullable no-FK. |
| `assets` | **Tenant** | Tenant content metadata (bytes in the tenant's R2 — separate connector, A4). |

### Two classes of tenant table (verified against the code)

**Class 1 — transaction-bound to the entry write (on the `dbc`/`tx` executor).**
These run *inside* the entry write's executor and MUST co-locate or atomicity
breaks:

- **`entries_trash`** — `deleteEntryCore(dbc, …)` moves a row
  `entries → entries_trash` in one CTE on the executor, preserving the uuid.
  Split across DBs and the delete is no longer atomic — a crash orphans or
  double-lands the row.
- **`transact_receipts`** — written on `tx` as the first statement *inside*
  `withTransaction` ([lib/entries.ts:1573](../../lib/entries.ts)), receipt-first
  so a rollback consumes no key. A cross-DB receipt is impossible.

**Class 2 — post-commit derived writes (currently on the singleton `db`).**
The change feed, versions, and audit are **not** in the entry transaction today.
The public wrappers write them after the core returns, in two flavors:
`recordChange`/`recordChanges` are **`await`ed** post-core
([entries.ts:385, 641, 1649](../../lib/entries.ts)); `recordVersion` and
`recordAudit` are **fire-and-forget via `defer()` / Next `after()`**
(versions.ts:26, audit.ts:22) — they run *after the response*. All four are
**separate round-trips on the singleton connection**, none part of the entry
write. So there is no atomicity to preserve — but there IS a routing decision:
these tables should live in the **tenant DB** (tenant-content-derived; the
delivery change-feed reads them per-project), so the `record*` helpers must be
**re-pointed from the singleton to `tenantDb(projectId)`** (§4).

`entry_changes.seq` is a **per-DB** bigserial: a private sequence in each
managed/BYO tenant DB, but in the fallback control DB (§8) it's a **single global
sequence shared by all connector-less projects** — so a fallback project sees a
sparse subset of `seq` values, not a dense 1..N. Correctness holds because reads
filter by `project_id` and need only monotonicity, not density (never derive
counts from `seq`).

`audit_log`, `webhook_deliveries`, `assets` are likewise tenant-volume and about
tenant content; co-locating them keeps the control-plane DB small and lets the
admin read "this project's logs" from the same connection it reads entries on.
Keeping them control-plane would re-import the scale problem the split exists to
solve.

> **Design consequence, not a hazard:** because Class-2 writes are already
> non-atomic with the entry write (separate round-trips today), the split does
> **not** weaken any guarantee that exists now — a crash between the entry commit
> and its change/version/audit row can drop that row today, and will still be
> able to after the split. If we ever want strict change-feed durability, the fix
> is the same in both worlds (an outbox row inside the entry tx) and is out of
> scope here.

### The FKs: present in the control DB, absent in tenant DBs (an asymmetry, not a drop)

Every tenant table today has `project_id → projects.id` (cascade) and the entry
tables also have `collection_id → collections.id`. A tenant DB **cannot** hold
those FKs — it has no `projects` or `collections` table (those are control-plane).
So the resolution is an asymmetry, not a global drop:

- **Control DB** keeps the full schema — including `projects`, `collections`,
  and the data-plane tables (which serve connector-less/fallback projects, §8) —
  with **all FKs intact**, exactly as `db/schema.ts` defines today. Nothing about
  the control DB's schema changes.
- **Tenant DBs** get the data-plane subset installed by the migration runner
  **without** the parent tables, so `project_id` and `collection_id` are plain
  columns with **no FK** (exactly as `entry_changes.collection_id` and
  `audit_log`'s loose refs already are — precedent exists).

**The one rule the application must follow:** never *depend* on the
`project_id`/`collection_id` FK for correctness of a tenant-table operation,
because the FK is absent in tenant DBs. In practice this is already true —
entry ops load the collection def from control-plane (cached) and validate in
app code; `delete_collection` already runs an app-level plan. The FK's continued
presence in the control DB is a harmless bonus that keeps fallback-DB cascade
teardown working (§8, §9) with zero code change to the smoke harness.

## 4. The resolver seam

**The hard part is already done.** The transact refactor (Phase 9) introduced
`DbExecutor` — the query surface (`select/insert/update/delete/execute`) that
both the neon-http `db` and a transaction satisfy — and threaded it as the first
param of every write choke point:

```
createEntryCore(dbc: DbExecutor, …)   updateEntryCore(dbc, …)
updateEntryIfCore(dbc, …)             deleteEntryCore(dbc, …)
```
([lib/entries.ts](../../lib/entries.ts): cores at 259/405/932/1239; public
wrappers call them with the singleton `db` at 379/638/1088/1290; transact passes
`tx` at 1587–1616.)

So the cores **do not change**. The seam is *who provides the executor*:

```
db/index.ts   →  controlDb            // the singleton, on DATABASE_URL (control plane)
lib/data-plane.ts (new):
  tenantDb(projectId): Promise<DbExecutor>          // neon-http on the tenant conn
  withTenantTransaction(projectId, fn): Promise<T>  // db-tx.ts, tenant conn string
```

- `tenantDb(projectId)` resolves the project's **neon connector** →
  decrypts the connection string (`connectorSecret(projectId, "neon", "prod")`,
  the existing AES-GCM slot accessor) → returns a cached neon-http drizzle
  client for that string.
  - **Resolver invariant (fail-closed):** the control-DB fallback (§8) applies
    **only when NO neon connector row exists.** A connector that is *present but
    unresolvable* — decrypt failure (`CONNECTOR_MASTER_KEY` wrong/unset throws in
    `crypto.ts`), or the tenant DB unreachable — must **throw**, never silently
    degrade to `controlDb`. Degrading would read/write the wrong (empty) database
    and, worse, could write a connector-backed project's content into the shared
    control DB. This invariant needs an explicit test in A1.
- The public wrappers change `createEntryCore(db, …)` →
  `createEntryCore(await tenantDb(projectId), …)`; transact builds its Pool from
  the tenant connection string instead of `process.env.DATABASE_URL`
  ([lib/db-tx.ts:34](../../lib/db-tx.ts) is the single place that hardcodes it).
- **Control-plane** queries (access, tokens, connectors, collections, jobs,
  schedules, workspaces) keep using `controlDb`. They never take a resolver.

### Blast radius

Every module that touches a **tenant** table routes through `tenantDb`:
`lib/entries`, the entry-op parts of `lib/collections`, `lib/changes`,
`lib/versions`, `lib/trash`, `lib/search`, `lib/assets`, and the delivery +
MCP + admin call sites that read/write entries. Everything touching
control-plane tables is untouched. **Three** distinct kinds of edit — only the
first is trivial:

1. **Executor-passing call sites** (the easy majority): the entry cores already
   take `dbc`, so the public wrappers change `…Core(db, …)` →
   `…Core(await tenantDb(projectId), …)`, and `withTransaction` →
   `withTenantTransaction(projectId, …)`. Pure plumbing. **Don't miss** the
   transact idempotency-replay read in the `ReplaySignal` catch
   ([entries.ts:1632-1641](../../lib/entries.ts)) — it reads `transactReceipts`
   on the singleton, but receipts move to the tenant DB; left unrouted, a
   legitimately idempotent retry reads an empty control-DB receipts table and
   returns `{replayed:true, results:[]}` instead of the original ids.
2. **The `record*` helpers** (`recordChange`, `recordChanges`, `recordVersion`,
   `recordAudit`, and the webhook-delivery logger): these take **no executor**
   and use the module singleton. They must resolve `tenantDb(projectId)`
   internally (they already have `projectId`) so Class-2 rows land in the tenant
   DB next to the entries they describe.
3. **Cross-plane JOINs that must be decomposed** (the genuinely structural
   part): `verifyRefs` ([entries.ts:75-159](../../lib/entries.ts)) — the "an AI
   can't dangle a relation" guarantee, run on *every* create/update/update_if,
   in the hook paths, and in the transact prep pass — validates relation targets
   with the **only SQL join in `lib/`**:
   `.from(entries).innerJoin(collections, …).where(collections.projectId=…, collections.name=…)`
   (entries.ts:133). With `entries` in the tenant DB and `collections`
   control-plane (§5), Postgres cannot express this join. It must be
   **decomposed**: resolve each relation's `targetCollection` name → `collectionId`
   from the control-plane `getCollection` cache first, then run a single-table
   `entries WHERE collection_id = <id> AND id IN (…)` on `tenantDb`. Its
   asset-existence branch (entries.ts:100-124) also reads the tenant `assets`
   table on the singleton and needs re-pointing. Grep `innerJoin|leftJoin` before
   A1 to confirm this is the only such site.

**Concrete scope (grep of `(db|dbc|tx).(select|insert|update|delete|execute)`):
166 call sites across 33 files.** The split is roughly even:

- **Tenant-routed** (→ `tenantDb`): `lib/entries.ts` (31), the entry-op half of
  `lib/collections.ts` (of 26 — the entry writes + the `db.execute(sql.raw(...))`
  index syncs, see below), `lib/trash.ts` (10), `lib/changes.ts` (6),
  `lib/versions.ts` (3), `lib/locales.ts` (8), `lib/search.ts` (1),
  `lib/audit.ts` (2), `lib/webhook.ts` (3), `lib/r2.ts`/assets (6), plus the
  delivery/MCP/admin read call sites.
- **Control-plane** (stay on the singleton): `lib/jobs.ts` (8),
  `lib/schedules.ts` (5), `lib/connectors.ts` (6), `lib/access.ts` (4),
  `lib/tokens.ts` (2), `lib/manifest.ts` (2), and the admin/settings actions.

Note `syncUniqueIndexes`/`syncSearchIndex` in `lib/collections.ts` create
per-collection partial-unique + GIN indexes via `db.execute(sql.raw(...))` **on
the entries table** — but they **hardcode the module singleton and take no
executor** (collections.ts:597-651), so they are *not* "unchanged": they need the
same re-pointing to `tenantDb` as the `record*` helpers (kind 2). That makes
`define_collection` a **non-atomic two-DB** operation: write the `collections`
row (control) + sync indexes and run any field backfills (tenant). If the tenant
DDL fails after the control write, the collection exists without its unique
index — so `define_collection` must be **idempotent/resumable** (re-run
reconciles the tenant indexes) or sequence the control write last. Same applies
to `deleteCollection`'s index-drop calls.

This is one instance of a broader class: **cross-plane schema ops** that write
control-plane config then backfill tenant rows, near-atomic today because they're
one DB. Field **rename** writes `collections` (control) then `UPDATE entries` +
`UPDATE entries_trash` (tenant) ([collections.ts:1123-1140](../../lib/collections.ts));
**locale** changes write `projects.locales` + `collections` (control) then
backfill `entries` (tenant) ([locales.ts:165-252](../../lib/locales.ts)). Each
must define a plane-commit order and be **idempotent/resumable** so a partially
applied rename/locale op is detected and reconciled (re-run on next define, or a
per-collection version marker) rather than left half-done across two DBs.

### Connection lifecycle

- **neon-http** (the default read/write path) is stateless per request — one
  HTTPS round-trip per query. A per-`(connString)` `drizzle(neon(str))` client is
  cheap to build and cache in a module map keyed by a hash of the conn string.
  Precisions A1 will trip on: this module map is **separate** from
  `getConnector`'s `unstable_cache` (rotation must bust **both** — wire an
  explicit eviction hook into the neon-connector rotate/disconnect action
  alongside the existing `revalidateTag`); the map is **per-serverless-instance**,
  so "evict on rotate" only clears the instance that handled the rotate — fine,
  because a new conn string yields a new key and stale entries self-heal; and the
  cache saves the client build, **not** the per-request `connectorSecret` decrypt
  (see the master-key note in §8).
- **Cold-start fan-out (a real cost):** a single entry write already fans into
  ~4-6 tenant round-trips (`verifyRefs` existence check, the insert, awaited
  `recordChange`, deferred `recordVersion`+`recordAudit`) plus a control-DB
  collection read. If a managed project is its **own** Neon compute (§13 Q5)
  that has autosuspended, the first round-trip eats a multi-second cold start.
  This raises the stakes on the branch-vs-project-per-tenant decision (§13 Q5) and
  argues for batching the per-write tenant round-trips where possible and a
  keep-warm strategy for active tenants.
- **Pool/ws** (transact only) is stateful. Today `withTransaction` builds a
  fresh single-connection Pool per call and closes it in `finally` —
  deliberately un-pooled. Keep that per-call model for `withTenantTransaction`
  (one short-lived Pool to the tenant DB per transact), so we inherit its
  serverless-safety with zero new lifecycle work. Revisit pooling only if
  transact volume makes per-call pools a bottleneck.

## 5. The one hard call: where `collections` lives

`collections` is both **schema config** (the AI composes it; the admin lists it;
cross-project platform queries count it) *and* the **parent of entries** (FK
today). It can't be both cheaply. Options:

- **(A) Collections stay control-plane; `entries.collection_id` is loose in
  tenant DBs** (FK retained in the control DB, §3). Entry ops load the collection
  def from the control-plane DB (already cached via
  `unstable_cache`), then read/write entries in the tenant DB. Cross-project
  schema queries and the admin collection list stay trivial (one control-plane
  query). Per-collection indexes (unique partial, GIN) are created on the
  *entries* table in the tenant DB by the runtime index sync, targeting the
  tenant connection. **← recommended.**
- **(B) Collections travel to the tenant DB** (fully self-contained tenant DB).
  Schema + data together; but the admin collection list and any cross-project
  schema query now fan out to N tenant DBs, and `define_collection` writes span
  two DBs. Loses the cheap central schema view for no atomicity gain (schema
  edits aren't in the entry-write hot path).

**Recommendation: (A).** It matches how the code already works (load collection
def → operate on entries as two steps), keeps the control plane centrally
queryable, and the loose `collection_id` in tenant DBs follows the precedent
`entry_changes.collectionId` already sets. The cost — app-enforced
collection→entry integrity — is a cost we already pay on the read path.

## 6. Coordination tables: jobs & schedules stay control-plane

`jobs` and `project_schedules` are drained by **one** endpoint
(`POST /api/jobs/drain`) that claims across **all** projects with a single
`FOR UPDATE SKIP LOCKED` statement. Per-tenant-DB jobs would force the drain to
poll N databases — a non-starter. They stay control-plane. This is safe because:

- **Job enqueue is not atomic with entry writes.** Delayed actions/events enqueue
  jobs at *emit* time, which is **post-commit** (events fire after the entry
  write commits). So the enqueue is already a separate step from the entry write
  today — moving entries to another DB doesn't break an atomic boundary that was
  never there.
- **Job handlers do cross-DB reads — and the split is per-table, not per-handler.**
  A delayed-action job re-resolves current state at run time. Today
  `lib/job-handlers.ts` reads `db.select().from(collections)` (:36) and
  `db.select().from(entries)` (:52) on the **singleton**. Post-split these two
  reads route to **different** databases: the **collection** read stays on
  `controlDb` (collections are control-plane, §5 — a tenant DB has no
  `collections` table, so pointing it at `tenantDb` would itself 500), and the
  **entry** read moves to `tenantDb(projectId)` (the job row carries `projectId`).
  Get this wrong in either direction and the handler silently returns
  (`if (!entry) return` / `if (!collection) return`) — **the delayed action
  becomes a no-op with no error.** This precise per-read routing must be in the
  A1 checklist.

**Accepted consequence (document, don't fix):** an entry write can commit in the
tenant DB and its post-commit job enqueue (control plane) can then fail — an
entry with no delayed job. This failure window exists today in milder form
(post-commit emission can fail after the write). It is at-most-once for the
*scheduling*, not a data-integrity issue. If it ever bites, the fix is an outbox
row in the tenant DB drained into the control-plane queue — deferred.

## 7. The migration runner

Today: **push-only** (`drizzle-kit push`, no `db/migrations` dir), and
`db:push` is **broken against Neon PG18** for incremental changes (columns
applied by hand — [prod-deploy-and-smoke]). That cannot scale to N tenant DBs.

Design a real, programmatic, **versioned** runner for the tenant-DB subset:

- An ordered list of migration steps (plain SQL or a typed builder), each
  idempotent, starting at **v1 = the current data-plane schema** (greenfield, so
  v1 is a clean create — no historical baggage).
- A `_schema_migrations` table **in each tenant DB** recording the applied
  version (there is no version marker today — this is new).
- **On provision:** run all steps → tenant DB at latest, as an ordered step in
  the provisioning state machine (§8) before the project is marked usable.
- **On platform schema change:** append a step; each tenant DB advances N→N+1
  (see the migrate-on-connect gate below). Runs are gated by an advisory lock so
  two drains can't double-apply.
- The runtime index syncs (`syncUniqueIndexes`, `syncSearchIndex`) run per
  collection on the tenant connection (§4, kind 2 — they are **not** unchanged).
  Extensions (pgvector for Phase 14's HNSW) are installed by the runner as a
  versioned step (`CREATE EXTENSION` per tenant DB — see the privilege caveat).

### The compatibility contract (the part that makes lazy migration safe)

**This is the highest-risk item in the whole design.** The app ships as **one
shared `db/schema.ts`** deployed atomically, and Drizzle emits the **full column
set** on both reads and writes: `queryEntriesPage` does
`db.select().from(entries)` with no projection ([entries.ts:1970](../../lib/entries.ts) —
Drizzle enumerates every declared column) and `createEntryCore` does a no-arg
`.returning()` ([entries.ts:270-288](../../lib/entries.ts) = all columns). §4
routes exactly these statements at `tenantDb`. So the instant an additive column
lands in `schema.ts` and deploys, **every tenant DB not yet migrated 500s on
reads *and* writes** (`column X does not exist`) — not just writes — until it
catches up. A BYO Postgres that can't run a step (e.g. no `CREATE EXTENSION`
privilege) would wedge **permanently**. Mitigations, all required before A2:

1. **Expand/contract only.** New columns are added **additively**
   (nullable/defaulted) and are **not referenced by deployed code** until every
   tenant is at that version; drops happen a release *later*. Because Drizzle's
   schema object is global, either gate the emitted column shape on the tenant's
   version or switch these hot statements to **explicit projections** so a
   lagging tenant DB doesn't break.
2. **Migrate-before-first-use gate** (not an "or"): `tenantDb(projectId)` checks
   `_schema_migrations` and migrates up before returning the client, with a
   bounded timeout and a defined failure path (never a silent 500). A resumed
   Neon compute self-heals here on its next connect.
3. **Quarantine state.** A tenant DB that cannot complete a step (BYO down, or
   BYO lacking a required privilege) goes **read-only/quarantined** with a
   surfaced error — not a write-500 storm.
4. **Per-extension privilege check at connect** (§8 BYO validation): verify e.g.
   `CREATE EXTENSION pgvector` is grantable before offering the feature; refuse
   or quarantine features whose extension is unavailable, rather than wedging at
   the versioned step.

Open sub-question for A1: hand-write SQL steps, or generate from Drizzle
snapshots. Given the PG18 push breakage, **hand-authored ordered SQL** is the
safer bet — deterministic, reviewable, no drizzle-kit dependency in the hot path.

## 8. Provisioning & the test/dev data plane

A `neon` connector type (rides the existing `project_connectors` model —
per-`(project,type)`, AES-GCM secrets, slot map, config JSON):

- **BYO:** the tenant pastes a connection string (or grants a Neon API key). We
  validate (connect, check version/permissions), run the migration runner to
  install the data-plane schema, store the string encrypted in a `secretsEnc`
  slot. `config` holds non-secret metadata (region, `mode: "byo"`).
- **Managed:** we call the Neon API (our org, our API key — a platform secret,
  not a connector) to create a Neon project, capture its connection string,
  install schema, store encrypted. `config.mode = "managed"`, `config.neonProjectId`
  for later teardown. On project delete (B2), call the Neon API to delete it.

**Provisioning is a resumable state machine (A3), not a straight line.** It spans
an external API + two DB writes with no cross-DB transaction, so any mid-sequence
failure orphans state (e.g. migrations succeed but the connector store fails → a
**paid, untracked** managed Neon DB with no teardown handle). Required ordering:
**store `neonProjectId` first** (so teardown always has a handle even if a later
step fails) → run the migration runner → store the encrypted connection string →
readiness check → only then mark the project **active**. Each step idempotent and
resumable; a half-created managed project has a defined cleanup path. The project
sits in a `provisioning` state until the data plane passes readiness.

**The master key becomes load-bearing for the whole data plane.** Today
`CONNECTOR_MASTER_KEY` is optional (only resend/stripe secrets use it). After the
split, `connectorSecret(projectId, "neon", …)` sits on **every content read/write
of every connector-backed project** — a misconfigured key fails all their
delivery/MCP/admin content ops closed (this is by design per the fail-closed
invariant, §4, but it must be a **validated startup dependency**, not a latent
one). And `crypto.ts` has a **single key with no `kid`/version**, so rotating
`CONNECTOR_MASTER_KEY` would break every stored connector. Before A2 stores real
Neon connection strings, design **keyed envelopes** (a `kid` per ciphertext, a
dual-key decrypt window, background re-encrypt) so the platform's most
load-bearing secret is rotatable.

**Health + observability for N tenant DBs (A2).** `checkConnectorHealth` handles
clerk/resend/stripe but has no neon equivalent. Add a neon-connector probe
(**connect + `_schema_migrations` at expected version**) surfaced on the
connector card, so a broken/paused/lagging tenant DB is visible *before* a
content op 500s. Note the Class-2 `defer()` writes swallow failures — decide
whether a deferred tenant-write failure should emit a per-project error signal
rather than vanish. Include a runbook line for "resolve a `projectId` → its DB".

### The fallback that makes tests and the free tier work

`tenantDb(projectId)` **falls back to `controlDb` when the project has no neon
connector.** So:

- **Smoke suite / seed / free-sandbox** projects have no neon connector →
  transparently use the shared control-plane DB's data-plane tables, via the
  *same code path*. No per-test Neon provisioning (which would be infeasible —
  a full smoke run creates dozens of ephemeral projects).
- **Managed/BYO** projects have a connector → their own Neon DB.

This means the **control-plane DB carries the full schema** (`db/schema.ts`
unchanged: control tables + data-plane tables + all FKs); its data-plane tables
serve connector-less projects, still isolated by `project_id` predicates exactly
as today. Tenant DBs get a **strict subset** — the data-plane tables only, minus
the parent-table FKs (§3). The migration runner (§7) owns installing that subset;
`db:push` from `db/schema.ts` still provisions the control DB. Because the
fallback path is byte-for-byte today's behavior (shared DB, FK cascade intact),
the smoke harness's `destroy()` (a single `DELETE FROM projects` relying on
cascade) and every existing test keep working **unchanged** — the seam is proven
through the fallback with zero harness edits.

"Zero harness edits" holds **only through the fallback path** (A1). The smoke
helpers `queryAudit`/`queryDeliveries` read `audit_log`/`webhook_deliveries`
directly on `DATABASE_URL`, and `connectClerk`/`connectStripe` seed connectors
via raw SQL — all fine while ephemeral projects have no neon connector. But **A2's
BYO smoke** (a test project *with* a neon connector) will need those read-back
helpers to resolve the *tenant* connection, not raw `DATABASE_URL`. Flag it so A2
budgets the harness work.

Alternative considered: a dedicated shared "dev data plane" DB separate from the
control DB. Rejected for A1 as unnecessary complexity — the fallback-to-control
model is simpler and the control DB already holds this data today.

## 9. Deletion in the split world (feeds B2)

- **Delete a collection:** delete the control-plane `collections` row, then
  **net-new code** issues explicit `collection_id`-scoped deletes of
  `entries`/`entries_trash`/`entry_versions`/`entry_changes` on the tenant
  connection. Today `deleteCollection` relies on the `collection_id` FK cascade;
  tenant DBs have no such FK, so this cleanup must be written (it must not lean on
  the cascade that happens to survive in the control/fallback DB).
- **Delete a project (B2):** control-plane rows deleted (project + members +
  tokens + connectors + jobs + schedules + collections — cascade from `projects`
  still works in the control DB). The tenant data plane: **managed** → call the
  Neon API to delete the whole tenant DB (no per-table deletes needed); **BYO** →
  drop our records and stop routing, never touch the tenant's own DB;
  **fallback/connector-less** → the control DB's `DELETE FROM projects` cascades
  to its data-plane rows exactly as today. A soft-delete grace window (per B2)
  holds the managed teardown for N days.
- **Backups / PITR ownership** (aligns with LAUNCH-PLAN C5): **BYO** = the tenant
  owns their Neon, so we cannot back up or recover their content — an explicit,
  disclaimed non-guarantee (support + liability). **Managed** = we own PITR across
  N Neon projects/branches, a real operational commitment (define a retention
  window). **Fallback/free** = covered by the control-DB backup. State this
  boundary before selling managed.

## 10. Dev/prod environments (A5 preview)

With managed Neon, an environment is a **Neon branch**:

- **prod** = the project's main branch; **dev** = a copy-on-write branch of it.
- The `neon` connector stores a connection string **per environment** in slots
  (`prod`, `dev`). The resolver becomes `tenantDb(projectId, env)`.
- Each environment gets **its own `project_tokens`** (per-env MCP + delivery
  tokens) and its own delivery endpoint, so a staging build reads `dev` and the
  live build reads `prod` — no more mixing.
- **Promote** = apply the schema diff (the diff engine exists) from dev to prod;
  content promotion uses the export/import manifest. Branch teardown discards a
  dev environment.
- **BYO environments** need either two connection strings or a granted Neon API
  key to branch on the tenant's behalf — settle in A5.

A5 owns the detailed design, but env must actually be **sourced** in A1, not just
"anticipated" — today `resolveToken` returns only `{projectId, scope}`
([tokens.ts:33-58](../../lib/tokens.ts), no env column) and `get_project_info`
emits one set of URLs from a single `APP_URL` base with no env dimension. So A1
does the minimum to make env real while behavior stays all-`prod`:

- add a nullable `env` column to `project_tokens` (default `prod`);
- thread it through `TokenInfo`/`resolveToken`;
- make the resolver `tenantDb(projectId, env: Env = "prod")`, with the connector
  slot keyed on `env` (`connectorSecret(projectId, "neon", env)`);
- accept the defaulted `env` at every `tenantDb` call site.

Then A5 only branches the connector, mints `dev` tokens, and makes
`get_project_info` env-aware — not a resolver rewrite.

## 11. What this design deliberately does NOT solve

- **Cross-project reads in one query** (studio fleet counts, `accessibleProjects`)
  stay control-plane and read only control-plane tables. Any dashboard metric
  that needs *tenant-DB* aggregates (entry counts per project) either (a) reads a
  cached counter kept control-plane (ties to Track B usage counters), or (b)
  fans out — **(a) is strongly preferred**; per-project entry totals become a
  usage-counter concern, not a live cross-DB scan.
  - **Concrete existing breakage, not future work:** [app/admin/page.tsx:26](../../app/admin/page.tsx)
    computes the fleet's per-project **entries count** and **last-write pulse**
    with one cross-project `GROUP BY` / `max(updatedAt)` on the shared `entries`
    table. The moment A2/A3 lands the first connector-backed project, those
    numbers go **silently wrong** (that project's entries leave the shared table)
    with no error. So the control-plane usage counter must land **before A2
    ships**, or the fleet must accept documented zeroes for connector-backed
    projects. This is an A1/A2 checklist item, not a §11 someday.
- **Assets vs R2 during the A1→A4 window:** A1 moves `assets` *metadata* to the
  tenant DB, but bytes stay in the single shared R2 until A4. Deleting a managed
  project in that window drops the tenant DB — and with it the only index of
  `r2Key`s — orphaning bytes in the shared R2. Mitigate by either **deferring the
  `assets`-row move to A4** (keep metadata + bytes teardown co-located), or
  guaranteeing project-prefixed `r2Key`s **plus** a control-plane tombstone of
  pending R2 deletions written at project-delete.
- **Rate-limit store:** unaffected today (in-memory `MemoryStore`, not DB-backed).
  If it ever becomes shared/DB-backed, it is **control-plane** coordination state
  (cross-project), never tenant data — keep it on `controlDb`.
- **Global search across projects** — not a goal; search is per-project.
- **Moving a project between BYO and managed** after creation — out of scope for
  A1; would need a data copy. Provisioning mode is set at setup.
- **Connection pooling for high transact volume** — per-call Pools for now.

## 12. Increment mapping (Track A)

- **A1** — `lib/data-plane.ts` resolver (`tenantDb(projectId, env="prod")` /
  `withTenantTransaction` + connection cache + fail-closed control-DB fallback),
  thread it through every tenant-table call site **including the three edit
  classes** (executor swaps + the transact-replay read; the `record*` helpers;
  the `verifyRefs` join decomposition + the index-sync helpers), split
  `db/index.ts` into `controlDb`, add the `env` column + thread it, and build the
  versioned migration runner with `_schema_migrations` + the **expand/contract
  compatibility contract** (§7). The big lift; everything stacks on it. Verified
  by the smoke suite running green **through the fallback path** (proves the seam
  without any real Neon).
- **A2** — `neon` connector, **BYO** mode: connect/validate/install/store/route,
  connector admin card.
- **A3** — **managed** provisioning via the Neon API (our org); auto-provision on
  project create; teardown on delete.
- **A4** — R2 as a connector (BYO + managed bucket); assets + image derivatives
  ride the resolver's storage equivalent.
- **A5** — dev/prod environments (Neon branches, per-env tokens/endpoints,
  promote via schema-diff).

## 13. Open questions for the review

1. **Collections placement** — confirm (A) control-plane, `collection_id` loose
   in tenant DBs (§5).
2. **High-volume logs** — `audit_log` / `webhook_deliveries` to the tenant DB as
   proposed, or keep control-plane for a unified admin log view? (§3)
3. **Migration authoring** — hand-written ordered SQL vs Drizzle-generated (§7).
4. **Test data plane** — fallback-to-control-DB vs a dedicated shared dev DB (§8).
5. **Managed provisioning granularity** — a Neon *project* per tenant project, or
   one Neon project with a *branch/database* per tenant project? (cost, limits,
   branch quotas — needs Neon API facts before A3.)

   **✅ ANSWERED 2026-07-11 (A3 research, verified against live Neon docs):
   ONE NEON PROJECT PER TENANT PROJECT, in our org, via an org API key.**
   - **Quotas:** Free/Launch = 100 projects per org; **Scale = 1,000 projects
     (soft limit, raisable on request)** — ≫ launch scale.
   - **Cost shape:** usage-based, **no per-project minimum** (invoices < $0.50
     not collected). Compute $0.106/CU-hr (Launch) / $0.222 (Scale); storage
     $0.35/GB-mo. **Scale-to-zero** (5 min default; Scale plan configurable
     1 min–always-on) → an idle managed tenant costs ≈ storage only. Fits
     pay-per-project + caps exactly.
   - **A5 alignment:** branches included per project (10 Launch / 25 Scale,
     $1.50/branch-mo beyond) → the tenant's **dev environment = a branch
     inside the tenant's own Neon project**, not a shared-org resource.
   - **API:** `POST /api/v2/projects` (Bearer org key; `region_id`,
     `pg_version` 14–18; response carries `connection_uris` +
     `operations[]` to poll before first connect — creation is async).
     `DELETE /api/v2/projects/{id}` removes everything and is **recoverable
     for 7 days** (`POST /projects/{id}/recover`) — B2's teardown grace
     window for free.
   - **Rejected:** branch-per-tenant (25-branch quota, teardown = surgery on a
     shared project, PITR/restore entanglement, weaker isolation story) and
     database-per-tenant on one instance (shared compute/noisy neighbor, no
     per-tenant scale-to-zero, undermines the "everything isolated" promise).
6. **The FK asymmetry** (§3) — accept FKs-in-control-DB / no-FKs-in-tenant-DB
   (keeps the smoke harness and fallback teardown untouched), or unify to
   app-level cascade everywhere for a single schema shape? Recommendation: accept
   the asymmetry — it's the lower-risk, zero-harness-change path.

7. **A4 R2-connector facts (researched 2026-07-11, live Cloudflare docs):**
   - **Bucket create/delete work over the plain S3 API** (CreateBucket /
     DeleteBucket implemented; region is always `auto`; no ACLs) — managed
     bucket provisioning rides the S3 client we already ship, PROVIDED the
     platform R2 token is **account-scoped** (Admin R&W), not bucket-scoped.
     DeleteBucket requires the bucket to be emptied first.
   - **Public access for managed buckets:** the r2.dev “public development
     URL” IS API-enableable — `PUT /accounts/{account_id}/r2/buckets/{bucket}
     /domains/managed` (Cloudflare REST, needs a `CF_API_TOKEN` with R2:Edit —
     a NEW platform secret) → serves at `https://{bucket}.{account_id}.r2.dev`.
     Cloudflare labels r2.dev non-production and rate-limits it around
     hundreds of req/s per bucket — **accepted for launch** (a tenant site's
     media stays well under that); the production upgrade is a custom domain
     per bucket (e.g. `{slug}.media.pluggie.app`), a post-launch increment.
     Rejected alternative: app-proxied private buckets (changes the absolute-
     URL delivery contract everywhere + pays app egress on every media hit).
   - **BYO shape:** tenant supplies Cloudflare account id, access key id,
     secret, bucket name, and THEIR public base URL (custom domain or r2.dev
     they enabled). Validation = write a probe object via their keys, fetch it
     through their public base URL, delete it — proves credentials AND public
     serving in one pass. Zero-asset guard mirrors A2 (asset URLs are minted
     absolute at upload, so attaching storage mid-life would strand them).
   - **B2 interplay:** deleteProjectObjects becomes mode-aware — fallback =
     prefix-delete in the shared bucket (today's behavior); BYO = never touch
     their bucket; managed = empty + DeleteBucket.
