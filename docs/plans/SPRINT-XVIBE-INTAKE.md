# Sprint — XVibe intake: the five scheduled items

> **✅ COMPLETE 2026-07-30, same day.** CP-A `a0cfb72` · CP-B `91edc77` ·
> CP-C `6992092` · CP-D `60d4c59` · CP-E receipts + full verify. All five wall
> items closed with receipts. Two bonus finds en route, both fixed in CP-D:
> schedule-mutate where/guard clauses skipped the shared field gate at define
> time, and suite 107's schedule tests were passing on a broken recurrence
> grammar rather than on the gates they named.

> **Living — started 2026-07-30.** Executes the SHIP half of the first
> post-freeze wall batch (8 items from xvibe, triaged with the operator
> 2026-07-30 — 2 already closed with receipts, DX-2 already shipped `d0a7f89`).
> Protocol: checkpoints per [../pm/BURNDOWN.md](../pm/BURNDOWN.md) — gate,
> commit, push; wall receipt via `wall-resolve.mjs` as each item closes.

## Deliberately NOT in this sprint

- **QRY-4 / environments** (twin projects, switcher, publish, Neon branching) —
  needs its own plan: operator decisions embedded (dev-twin billing, branch
  mechanics on BYO Neon), and it is next-sprint-sized. The design lives in
  BACKLOG's QRY-4 detail section.
- **CONTRACT-1 full pass** — the flagship after this sprint; this sprint ships
  only its FIRST deliverable (the registry, CP-A), which stands alone.

## Checkpoints

### CP-A · notSupported registry + the publicRead trap *(wall `2479b787`, `21f4c5d5`)*

1. **`briefing.notSupported`** in `get_project_info`: a short, curated list of
   capabilities the platform does NOT have, each entry `{capability, status:
   not_supported|scheduled|declined, alternative, ref}` where `ref` is a
   BACKLOG id. **The registry must not become the stale list it replaces**: a
   smoke test parses BACKLOG.md and FAILS if any cited row is ✅ Shipped — the
   same cross-examination discipline `npm run pm` applies to receipts.
   Content: SMS sends · recurring/subscription checkout · delivery-side bulk
   write/delete · range/absence filters on delivery reads · delivery
   Idempotency-Key / If-Match · timezone-aware schedules · platform-side
   credential verification · generic third-party API proxy (declined) ·
   environments/branching (scheduled).
2. **WP-9**: when `access.read` is gated, `define_collection`'s `accessNote`
   states the trap — *access gates WHO reads; `publicRead` still chooses WHICH
   fields, for authenticated readers too* — and NAMES the delivery-hidden
   fields. (Note, not warning: hidden fields on a gated collection are often
   intentional; the note makes the semantics impossible to misread once.)
   Plus the `COMMON_FIELD_CONFIG` copy fix.

### CP-B · WF-1: `transitions[].set` *(wall `0cd6dce5`)*

`{from, to, actors, when, set: {field: "now" | {value} | null}}` — stamped in
the SAME conditional UPDATE as the transition (both the plain and the CAS
path, so scheduled mutate-transitions inherit it). Define-time validation
mirrors schedule `set`: field exists, not the workflow field, not computed,
not write-only (a static value in a schema is not a secret), `"now"` on date
fields only, `{value}` type-validated. Same-state no-op writes must NOT stamp.

### CP-C · DX-7: `dryRun` on `define_collection` *(wall `61f9b82e`)*

Full validation + the complete diff plan (including renames, locale toggles,
constraint warnings), nothing applied — for new collections too ("would
create"). The `transact` dryRun contract is the model: everything above the
write proves the call is well-formed. Test: dryRun leaves `list_collections`
untouched and its plan equals the destructive-confirm plan for the same input.

### CP-D · OPS-6: `reset_project` *(wall `ad7568ba`)*

Confirm-gated (plan first: counts of collections/entries/trash/blocks/
schedules/jobs/feed rows). Wipes content + schema + automation in dependency-
free order (everything goes, so inbound-relation blocking does not apply).
KEEPS tokens and connectors — deleting the caller's own credential mid-call is
a trap, and connectors are project identity; the plan says so explicitly.
`schema.manage` scope.

### CP-E · close-out

`npm run verify` (full suite) · wall receipts for all four SHIPs · BACKLOG
rows → ✅ with hashes · CAPABILITIES + contract regen (tool surface changes in
CP-B/C/D) · pm reconcile — wall should read 38/40 with only QRY-4-absorbed and
CONTRACT-1-remainder open.

## Sizing

| CP | Items | Size |
|---|---|---|
| A | registry + WP-9 note | S + S |
| B | transition set | M |
| C | define dryRun | M |
| D | reset_project | M |
| E | verify + receipts | S |
