# Scale & Content-Model Plan

**Status:** Phase A1 + A2 SHIPPED & verified (commit 6221c26, local, not pushed). A3 (keyset on indexed sort), Phase B (one-level repeaters), Phase C (refinements) still to do. A1's composite index needs hand-applying to the existing shared/prod DB (CONCURRENTLY, in a window) — db:push is broken vs Neon PG18. Test: `scripts/smoke/62-scale-indexes.test.mjs`.
**Goal:** scalable, fast, customizable — **without a rewrite**. The data model is already right (blob-per-entry + relations, *not* EAV). What's missing is an **index layer**, **two pagination fixes**, and the **modeling discipline** that keeps the query surface small. Plus the **AI-facing layer** so the agent models all of this correctly by default.
**No data migration:** indexes are additive; the JSONB shape is unchanged.

---

## Where we are (truth, from the code)

| Piece | Reality | File |
|---|---|---|
| Storage | one entry = one row + one JSONB `data` blob (`id, project_id, collection_id, data, created_at`). Not EAV. | `db/schema.ts:261` |
| Relations | resolved in ONE batched query — no N+1 | `resolveRelations` `lib/entries.ts:2032` |
| Indexed today | `collection_id` btree; `unique` partial-unique; `searchable` GIN(tsvector) | `lib/tenant-migrations.ts:89`, `lib/collections.ts:580` |
| Filter/sort compile | `data->>'field'` cast `::numeric`/`::timestamptz`/`::boolean` — **no matching index for plain fields** | `accessor` `lib/query.ts:71` |
| Pagination | keyset cursor over default `(created_at,id)` ✅ — **OFFSET fallback for custom orderBy** | `queryEntriesPage` `lib/entries.ts:1973,1990` |
| Nested content | in the blob, **excluded from queries** (correct) | `OPS_BY_TYPE` `lib/query.ts:46` |

**Foundation is sound.** The gaps are three, all localized:
1. **Un-indexed filter/sort → scans** at scale (no expression index for plain fields).
2. **Custom-order deep pagination is O(n)** (OFFSET fallback).
3. **Default list lacks its supporting index** — `collection_id` is indexed but there's no `(collection_id, created_at, id)` composite, so a big collection *sorts* instead of *seeks*.

---

## Phase A — the scale foundation (the keystone)

### A1. Composite base index `(collection_id, created_at, id)`
One line in `lib/tenant-migrations.ts` (next to `entries_collection_idx`). Makes the default list + keyset pagination a **seek**. Cheapest, biggest common-case win. Additive; safe.

### A2. `indexed` field flag → type-matched expression index
- **Flag:** add `indexed?: boolean` to `FieldBase` (`lib/field-types.ts`) + accept it in `fieldDefSchema` (`lib/validation.ts`). Valid only on filterable/sortable scalar types (text/number/date/boolean/enum) — reject on group/array (nested stays out of the query path).
- **Index creation:** extend the existing **index-sync** (`lib/collections.ts`, the machinery that already does `unique` + search GIN) to create/drop a **type-matched expression index** so the planner actually uses it:
  - text/enum → `((data->>'f'))`
  - number → `((data->>'f')::numeric)`
  - date → `((data->>'f')::timestamptz)`
  - boolean → `((data->>'f')::boolean)`
  The expression MUST match `accessor()` (`lib/query.ts:71`) exactly or the planner ignores it.
- **`unique`/`searchable` already imply their own index** — `indexed` covers the *filter/sort* dimensions those don't.
- **Cross-relation coverage:** a field used as a relation-filter *target* (`RelatedContext`, `lib/query.ts`) must also be `indexed`, or the EXISTS subquery scans.
- **Concurrency:** adding an index to an *existing large* collection must use `CREATE INDEX CONCURRENTLY` (the tenant-migration path deliberately avoids CONCURRENTLY — this feature needs the concurrent path so `define_collection` doesn't lock the table).
- **Runs tenant-side:** index-sync already runs on the project's own DB (incl. BYO-Neon).

### A3. Keyset pagination on an indexed sort field
When `orderBy` is on an `indexed` field, page by cursor over `(that field, id)` using its index instead of OFFSET (`queryEntriesPage`, `lib/entries.ts:1973`). Kills problem #2. Un-indexed sort keeps the OFFSET fallback (bounded) — or is discouraged (see C2).

---

## Phase B — the modeling discipline (keeps the query surface small)

### B1. One level of repeating
- `MAX_ARRAY_GROUP_DEPTH: 2 → 1` (`lib/field-types.ts`) — array-of-group **inside** array-of-group is now rejected at define time.
- **Flip the tests:** the depth-2 case in `scripts/smoke/60-structured-fields.test.mjs` changes from "allows repeater-in-repeater" to "**rejects** a second level."
- **Tighten the card:** a repeater item = scalars + a scalar sub-array (tags) + a relation. No nested group either → cards stay flat, the editor stays clean.
- **Note:** the recursion in validation/projection/write-gate/editor **stays** — one-level content still uses it (group items, scalar sub-arrays). "Out of the picture" = the depth-2 *contract* is un-createable + tested-rejected + documented, not code excised.

**Why B belongs here:** nested content is a read-whole blob that can *never* enter the query path, and deep/queryable structure is pushed to a **related collection** (which is `indexed`). The discipline is what *guarantees* the fast path stays fast.

---

## Phase C — refinements when volume demands (not now)
- **C1. Relation-label denormalization** — store `{id,label}` at write time so a read never needs the second query. Read speed vs. propagation cost; opt-in per relation.
- **C2. Index-backed-query guard** — warn/steer when a filter/sort hits an un-indexed field on a high-volume collection, so you can't *accidentally* author a scan.
- **C3. Whole-`data` GIN (`jsonb_path_ops`)** — a cheap catch-all making eq/containment fast on *any* field; doesn't help range/sort (those still want the per-field btree).

---

## The AI-facing layer (how the agent understands all of this)

The agent knows only what the tool surface teaches. This is first-class work, not docs polish. Two levers:

**Teach (so it models well by default):**
- `define_collection` / `list_field_types` docs explain **`indexed`**: *"mark a field `indexed` if you'll filter or sort by it on a collection that grows large; don't index everything — each index taxes writes."*
- A modeling rule string (BOUNDARIES-style): **"Data you query/search/reuse → its own collection (flat, indexed, related in). Content you display as a unit → a page with a one-level repeater."**
- Examples in the docs: the business-hours pattern (a `business_hours` collection with a flat hours repeater, referenced from a page block).

**Enforce (so even an imperfect pass lands right):**
- Depth-3 repeater → rejected with *"model the inner list as a related collection"* (already the message; keep it).
- Filter/sort on a nested field → rejected (already: empty `OPS_BY_TYPE`).
- (C2) filter/sort on an un-indexed field at scale → a teaching warning.

**Sensible defaults:**
- `unique`/`searchable` already imply an index — surface that so the AI doesn't double-declare.
- Consider auto-suggesting `indexed` for enum/status-shaped fields (common filter dimensions).

Net: the agent becomes *competent at scale modeling* because the tool surface teaches the rules and the guardrails enforce them — the same way it already can't spoof workflow state or write a private field.

---

## Sequencing, effort, risk

- **Order:** A1 (trivial) → A2 (keystone) → A3 → B1 (cheap) → AI-layer alongside A2/B1 → C later.
- **Effort:** medium, and it's all **extension of existing patterns** — index-sync already exists, keyset already exists, the flag mirrors `unique`/`searchable`. No rewrite.
- **Risk:** low-moderate. Main care items: expression index must match the `accessor` cast exactly; `CONCURRENTLY` for large existing collections; index-sync must run correctly on tenant DBs (see `[[prod-deploy-and-smoke]]` — the tenant-DB index runner). No data migration; indexes are additive and rebuildable from the blob.

## Touch points
`lib/tenant-migrations.ts` (A1 composite), `lib/field-types.ts` (`indexed` flag + cap→1), `lib/validation.ts` (accept `indexed`, reject nested), `lib/collections.ts` (index-sync: expression indexes, CONCURRENTLY), `lib/query.ts`/`lib/entries.ts` (keyset on indexed sort), `lib/mcp/tools.ts` (AI-facing docs), `scripts/smoke/*` (flip depth test; add index + keyset tests).
