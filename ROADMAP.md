# AgentX Roadmap

Vision: an MCP-native platform where an agent defines a project's data model and
gets back a branded client admin + delivery API — growing into a multi-tenant
platform where users bring their own infra as **connectors** (Clerk, Neon,
email, Stripe) and extend the agent's tool surface with **plugins**.

> Restructured 2026-07-07: Phases 8–18 are the **gap-closing track**, designed by
> an 11-designer / 22-adversarial-verifier pass grounded in the live codebase.
> Full implementation specs live in [docs/gap-designs/](docs/gap-designs/README.md)
> — each increment below has a concrete file-level spec there. Old Phases 6/7
> (multi-tenancy, plugins) are now Phases 20/21.

## Design rules (apply to every phase)

1. **Declarative + self-describing** — every capability is visible through the
   tool surface; tool descriptions state boundaries out loud.
2. **Machine-readable errors with fix hints** — an agent must be able to repair
   its own mistake from the error text alone.
3. **Secrets are references, never payloads** — provisioned credentials stay
   server-side; the agent gets a reference id, not a key.
4. **Destructive = plan + confirm** — anything that loses data returns a plan
   first and requires explicit confirmation (Terraform-style).
5. **The strict-validation invariant never weakens** — no feature may bypass
   per-field public-read or schema validation (this is why there is no raw SQL
   escape hatch).

---

## Shipped ✅

- **Phase 0 — v1 + projects system**: schema registry (8 primitives) · MCP server ·
  delivery API with per-field public read · branded auto-generated admin · R2
  assets · project tokens · members/roles · generated API reference · metadata caching.
- **Phase 1 — Agent-complete data layer** (2026-07-04): list/delete tools, guarded
  destructive ops, query filters + sorting, schema diff engine, export/import
  manifest, idempotency keys.
- **Phase 1.5 — Production hardening** (2026-07-04): scoped tokens, rate limiting,
  webhook reliability + delivery log, `publicFilter`, `get_entry`/`count_entries`/
  `bulk_create_entries`, asset tools. Plus (post-roadmap): `update_entry_if` CAS,
  `aggregate_entries`, per-field unique via partial indexes.
- **Phase 3 — Events & actions** (2026-07-05): entry.created/updated/deleted →
  webhook/email actions, single emit point, delivery log in settings.
- **Phase 4 — Identity-aware access, BYO issuer** (2026-07-05): per-project Clerk
  JWKS, end-user JWT verification, read/write presets public|authenticated|owner
  + ownerField stamping.
- **Phase 5.1–5.4 — Connectors** (2026-07-05): `project_connectors` + AES-GCM
  secrets, connector admin UI, Resend email, Clerk auth.

## Phase 2 — Deploy + dogfood (in flight)

Host is intentionally unpinned: Netlify today, likely Render later — every
mechanism below stays host-agnostic (pg-backed queues, HTTP-only streaming).

- [x] 2.1 Production deploy — Netlify (`agentx-currents.netlify.app`), 2026-07-06
- [x] 2.2 Production smoke suite (`SMOKE_BASE` override for prod runs)
- [ ] 2.3 Point a real Currents content site at the delivery API →
      **promoted to the Dogfood Acceptance Milestone after Phase 12**
- [ ] 2.4 Friction log — every wall hit during the real build, captured as issues
- [ ] 2.5 Token hygiene — rotate dev tokens, document handoff flow

---

# The gap-closing track (Phases 8–18)

Ordering is dependency-driven: Phases 8–12 build the complete envelope a real
branded member site consumes, then the dogfood milestone generates the evidence
that prioritizes 13–18. **Phase 13 ships the last shared machinery (jobs runner);
14–18 are deliberately reorderable on dogfood evidence.** Every increment is
S (≤half day) or M (1–2 days), independently shippable, and verified via a live
MCP/HTTP round-trip. Spec: [docs/gap-designs/](docs/gap-designs/README.md).

## Phase 8 — Constraint vocabulary + structured errors (spec: design-constraints)

Zero-migration foundation with the widest fan-out: `ConstraintIssue[]` is
consumed by transact, authz denials, hooks, and every later error surface.

- [x] 8.1 `A1` (S) — `pattern`/`patternHint` on text fields. *Verifier fix folded:*
      pattern **requires** `max` (≤10,000) on the field, plus an unconditional
      length pre-check before regex evaluation (ReDoS bound on public-write forms).
      ✅ 2026-07-07, smoke 97/97
- [x] 8.2 `A2` (M) — structured `ConstraintIssue[]` on every validation failure
      (field, constraint, limit/allowed/pattern, hint) — additive to error text.
      ✅ 2026-07-07, smoke 101/101
- [x] 8.3 `A3` (S) — date `min`/`max` bounds + `integer` on number fields.
      ✅ 2026-07-07, smoke 107/107
- [x] 8.4 `A5` (S) — `unique` on date fields + canonical UTC ISO normalization.
      *Verifier fix folded:* converge `matchClause` date-eq onto instant comparison
      (Date.parse both sides) in the same increment + list-vs-single smoke.
      ✅ 2026-07-07, smoke 107/107
- [x] 8.5 `A4` (M) — define-time tightening scan → `constraintWarnings[]`
      (pattern scan capped at 5000 rows — reported via `scannedRows`).
      ✅ 2026-07-07, smoke 112/112
- [x] 8.6 `A6` (M) — explicit unset via `null` + `required` enforced on update.
      ✅ 2026-07-07, smoke 112/112
- [x] 8.7 Adversarial-review fixes (14 confirmed findings). **The stated ReDoS
      bound was false** — input-length caps don't bound exponential backtracking;
      now `patternStarHeightSafe` rejects nested-quantifier patterns at define
      time (safe-regex heuristic), so runtime `re.test` is provably bounded. Also:
      bulk per-item failures now carry `issues[]`; the A4 scan can no longer crash
      `define_collection` (per-check `scanFailed` degradation) or feed unbounded
      legacy values to a regex; integer CAS guards legacy fractional rows;
      unique-on-date normalizes pre-A5 values; min/max/pattern narrowed
      per-interface. ✅ 2026-07-07

## Phase 9 — CAS completion + transact (spec: design-atomicity)

The shared-machinery phase: `withTransaction` (WebSocket pool) and the
`*Core(dbc)` refactor of create/update/delete restructure `lib/entries.ts`
**before** later phases bolt onto it.

- [x] 9.1 `B1` (M) — CAS completion: SQL-faithful `diagnoseCasFailure` (guard-specific
      E_CONFLICT messages, never guessed) + advisory pre-image so CAS events carry
      `previous`/`changedFields`. Exports `buildWhereParts` — the seam D3 builds on.
      ✅ 2026-07-07, smoke 123/123
- [x] 9.2 `B2` (M) — `transact([ops])`: `lib/db-tx.ts` interactive tx over
      @neondatabase/serverless Pool (added `ws` dep — pure-JS, host-agnostic;
      Netlify Node 18/20 has no global WebSocket), `*Core(dbc)` mutators returning
      emission descriptors, post-commit-only events. **MCP-only** (description says so).
      ✅ 2026-07-07, transact smoke 5/5
- [x] 9.3 `B3` (S) — cross-op refs: `ref` on creates, `$ref:<name>` in later ops.
      ✅ 2026-07-07, transact smoke 10/10
- [x] 9.4 `B4` (S) — `update_if` op inside transact + `dryRun` plan mode.
      Atomic book-a-seat composite; race-free diagnosis inside the tx. ✅ 2026-07-07, 16/16
- [x] 9.5 `B5` (S) — batch idempotency: `transact_receipts` ledger (migration).
      Receipt-first insert; replay returns original ids; rollback doesn't consume
      the key. ✅ 2026-07-07, transact smoke 18/18. *Note: drizzle-kit push left the
      unique index uncreated (interactive constraint-drop quirk on the existing DB);
      created `transact_receipts_key_idx` directly. A clean-DB push creates both.*
- [x] 9.6 Adversarial-review fixes (6 confirmed): `update_if` in transact now threads
      `assumeExisting` (same-batch `$ref` relations work); `diagnoseCasFailure` mirrors
      the integer `% 1 = 0` guard (a legacy fractional value gets a precise diagnosis,
      not a futile "concurrent change" retry loop); `updateEntryCore` returns a clean
      E_NOT_FOUND on a 0-row UPDATE (concurrent-delete race, pre-existing); transact
      rejects a batch that both deletes a row and relates to it; `ws` added to
      `serverExternalPackages`. ✅ 2026-07-07

## Phase 10 — Trash, purge, versions (spec: design-versioning)

The safety net to have in place **before** dogfooding: recoverable deletes make
aggressive iteration cheap.

- [x] 10.1 `C1` (M) — trash core: `entries_trash` row-move CTE (id preserved),
      `list_trash` + `restore_entry` tools, trash-aware asset delete gate.
      **Owns reconciling the transact delete op to trash uniformly.** Implemented in
      `deleteEntryCore` (the choke point) so MCP/admin/delivery/transact all trash
      uniformly; restore re-emits `entry.created` with `{restored:true, deletedAt}`.
      ✅ 2026-07-07, trash smoke 5/5. *(entries_trash indexes created directly —
      same drizzle-kit push quirk.)*
- [x] 10.2 `C2` (M) — `purge_entry` + `empty_trash` (plan + confirm) + lazy 30-day sweep.
      Purge plan surfaces inboundRefCount + assetsFreed; `sweepExpiredTrash` deferred
      from the delete path + list_trash; delete_collection plan gains trashedEntries;
      rename-backfill also runs against entries_trash. ✅ 2026-07-07, trash smoke 10/10
- [x] 10.3 `C3` (S) — admin Trash page (restore/purge) + sidebar link + `ConfirmButton`.
      ✅ 2026-07-07 (route compiles + auth-consistent; actions call tested lib fns)
- [x] 10.4 `C4` (M) — `entry_versions` pre-image snapshots on update +
      `list_entry_versions` (migration; cap 20/entry). `recordVersion` in
      `lib/versions.ts` (import-cycle-safe), hooked into update/CAS/transact.
      ✅ 2026-07-07, versions smoke 7/7
- [x] 10.5 `C5` (S) — version reaping wired into purge/empty/sweep (two-stage CTEs).
      ✅ 2026-07-07
- [x] 10.6 `C8` (S) — CAS pre-image. **Resolved the critique's 3-way conflict by
      REUSING B1's advisory pre-read** (`emit.previous`) rather than the self-join
      B1 rejected as wrong under READ COMMITTED — CAS now captures versions +
      `previous`/`changedFields` with no risky SQL rewrite. ✅ 2026-07-07
- [x] 10.7 `C6` (S) — `restore_entry_version` through the full validation pipeline
      (strict re-validate vs current schema; pre-restore state captured, so undoable).
      ✅ 2026-07-07
- [x] 10.8 `C7` (S) — admin version-history panel with one-click restore (entry edit aside).
      ✅ 2026-07-07
- [x] 10.9 Adversarial-review fixes: 3 confirmed (all MINOR; visibility-security +
      versions-correctness lenses came back CLEAN). Fixed emptyTrash to reap
      versions in one CTE (was non-atomic + could blow the 65535 bind-param limit
      on huge trash). Documented the rare rename-mid-restore race (a correct fix
      needs interactive-tx advisory locks — impossible on neon-http; recoverable
      by re-save). Left version-restore audit as `update` (accurate; `restore` is
      reserved for un-trashing). ✅ 2026-07-07

## Phase 11 — Query power + keyword search (specs: design-query-power, design-search E1–E3)

The delivery-facing features a real site actually consumes. All read-path, no migrations.

- [x] 11.1 `D1` (M) — MCP depth-1 `expand` on query_entries/get_entry
      (expanded value = `{id, label, data}`). `expandRelations` reads targets from
      `entries` only (no trash leak). ✅ 2026-07-07, query-power smoke
- [x] 11.2 `D2` (M) — delivery `?expand=` — target shown exactly as a direct GET
      would show it: publicRead projection + publicFilter row-gate + access.read
      public gate. ✅ 2026-07-07, query-power smoke (verified no private-field/
      hidden-row leak)
- [x] 11.3 `D3` (M) — MCP dotted-path where (`author.name eq X`) compiled to a
      parameterized EXISTS subquery over an aliased target. `collectRelatedTargets`
      builds a per-surface policy (mcp/delivery); gates recursion-safe (dotted
      inside a gate throws). Threaded through query/count/aggregate.
      ✅ 2026-07-07, query-power smoke
- [x] 11.4 `D4` (M) — delivery `?author.name=X` with **full target row gates**
      (access.read + publicRead + publicFilter inside the EXISTS). All 3 reviewer
      security scenarios verified. ✅ 2026-07-07, query-power smoke
- [x] 11.5 `D5` (M) — MCP `includeReverse` (children-of-parent, one windowed
      row_number query; exact per-parent hasMore; attached as a `related` sibling).
      ✅ 2026-07-07, query-power smoke
- [x] 11.6 `D6` (S) — delivery `?include=` reverse embeds, child publicFilter ANDed
      into the fetch + public projection + non-public 422. ✅ 2026-07-07
- [x] 11.7 `E1` (M) — `searchable` field knob + `lib/search.ts` FTS core
      (`websearch_to_tsquery`, 'simple' config, richtext tag-strip) + `search_entries`
      MCP tool (searches all searchable incl. private). ✅ 2026-07-07, search smoke
- [x] 11.8 `E2` (S) — delivery `?q=` keyword search, rate-limited, publicRead-scoped
      (verified: private searchable field NOT reachable, publicFilter respected,
      q+sort 422). ✅ 2026-07-07
- [x] 11.9 `E3` (S) — GIN expression index over the **public-searchable subset**
      (`syncSearchIndex`; same `searchVectorText` as the delivery query → planner
      match; rebuilt on subset change, dropped on delete). ✅ 2026-07-07, search smoke
- [x] 11.10 Adversarial-review fixes: **1 confirmed security leak (blocker) fixed** —
      delivery `?include=child.field` grouped children by a back-reference field
      *without* requiring it to be publicRead, disclosing `child.field == parent.id`
      for a private field. Now both delivery routes (and `includeReverse` public
      mode, defense-in-depth) require the back-ref to be a public relation field.
      Also refreshed the stale `get_project_info` delivery self-description with
      expand/dotted/include/search. ✅ 2026-07-07

## Phase 12 — Authorization ladder (spec: design-authz)

Parameterized **presets, not expressions**: one new shape
`ClaimRule = {claim, equals}` + array composition, all fail-closed.

- [x] 12.1 `F1` (M) — claim-based presets: `read`/`write: {claim, equals}` from
      verified BYO-Clerk JWT custom claims. Fail-closed (absent/non-string never
      match); claim-write is staff write (mutate any row); precise 403 distinguishing
      absent vs wrong value. Shared `accessSchema` zod for define + manifest.
      ✅ 2026-07-07, authz smoke
- [x] 12.2 `F2` (S) — any-of arrays: `write: ["owner", {claim:"role", equals:"moderator"}]`
      — normalized preset-list eval, owner as the fallback rung. ✅ 2026-07-07 (with F1)
- [x] 12.3 `F3` (M) — org/team row scoping `access.org {claim, field}` — fail-closed,
      org field server-stamped on create AND stripped on PATCH (tamper-proof),
      enforced as `rowClauses` (Gate contract change ownerClause→rowClauses[]) on
      every operation including F1/F2 claim roles. Define-time bars org+public and
      org+anonymous-write. ✅ 2026-07-07, authz smoke
- [x] 12.4 `F4` (M) — field-level write rules: `writableBy: "none" | ClaimRule`
      on FieldDef (delivery POST + PATCH; admin/MCP unaffected; identity fields
      exempt). ✅ 2026-07-07, authz smoke
- **Adversarial review** (4 lenses × verify) caught 3 real access-control holes,
  all fixed + regression-tested (21 authz smoke):
  - **A** anonymous `publicWrite` could forge `ownerField` (the owner twin of the
    org-injection bar) — closed at define time (symmetric owner bar) AND at runtime
    (`stampIdentity` strips stamped identity fields on the null-user path).
  - **B** relation `{id,label}` resolution leaked an org-scoped target's `labelField`
    cross-org (a non-org parent can point at an org target) — `resolveRelations` now
    gates the label by the viewer's org, fail-closed; MCP/admin pass `"trusted"`.
  - **C** PATCH/DELETE were unthrottled while claim-write grants any-row mutation —
    same rate-limit window as POST/search now applied.
- **Coordination contract:** F updates D2/D4's target-read gates to the
  preset-union shape; Phases 15/17 (K, H) are implemented against post-F shapes.
- Deferred: `F5` per-row sharing ACL — `entry_shares` side-table design recorded
  in the spec; build when a real project asks for "share this row with one user".

## ★ Dogfood Acceptance Milestone (= Phase 2.3–2.5)

Build the real Currents site on the platform. The envelope is now complete:
constraints + repairable errors, safe deletes, expansion/filtering/search,
member authz. **The friction log from this run decides the order of Phases
14–18** — search-quality ceiling → pull 14; commerce ask → pull 15; custom
validation ask → pull 16; sync/polling pain → pull 17; srcset/i18n need → pull 18.

## Phase 13 — Jobs, schedules, workflows (spec: design-time-flow)

One boring pg `jobs` table; the **last piece of shared machinery** (E's embed
backfill, C's sweep, H's prune, K's reconciliation all name it as their runner).

- [x] 13.1 `G1` (M) — jobs table + single-statement `FOR UPDATE SKIP LOCKED` claim
      — **PROVEN on neon-http** (spike: 60 jobs / 12 concurrent claimers → 0 double-claim,
      so plan-A, not the optimistic/`withTransaction` fallbacks) + hardened
      `POST /api/jobs/drain` (CRON_SECRET bearer, fail-closed 503 `E_UNCONFIGURED`
      when unset/<16, `timingSafeEqual` compare) + `list_jobs`. Review pre-fixes:
      dedupe index scoped by `project_id` (openMinor #1); opportunistic `after()`
      drain-nudges **deferred** out of G1 (openMinor #4 — cron is the guaranteed
      path). Netlify scheduled fn is the only host-specific piece. Adversarial
      review (4 lenses) caught a real queue-wedge: dedupe scoped to `pending` only
      let a duplicate slip in while the original was `running`, so its
      `running→pending` reschedule collided → stall. Fixed: dedupe index covers
      `status IN (pending, running)`; regression-tested. ✅ 2026-07-08, 23-jobs smoke
- [x] 13.2 `G2` (S) — delayed actions: `after: "3d"` on EventAction (1m..365d);
      queued payloads are **references + actionHash** (sha256 canonical JSON,
      `disabled` excluded so pause keeps identity) — current config re-resolved at
      run time: absent/edited/disabled action or deleted entry → skip-as-succeeded,
      `when` re-evaluated against the CURRENT entry. Timer pins to the FIRST
      matching event (dedupe per entry+event+action; documented). `runEventAction`
      is the shared dispatch exit for immediate + delayed (+ later G3/G4) actions.
      ✅ 2026-07-08, 24-delayed-events smoke (7)
- [ ] 13.3 `G3` (M) — recurring schedules: `project_schedules` + define/list/delete_schedule
      + drain-tick (migration; makes `webhook_deliveries.collectionId` nullable —
      unblocks K4's unmapped-event logging).
- [ ] 13.4 `G4` (M) — declarative state machines: `collections.workflow`
      {field, initial, transitions[{from, to, actors, actions}]}; enforcement via
      shared `applyWorkflowOnCreate` called from **all** create paths (single +
      bulk + transact cores); transitions actor-gated (delivery excluded by default).
- [ ] 13.5 `G4b` (S) — CAS-transition proof: racing-transitions smoke isolating the
      self-join pre-image claims before anything composes on them.
- [ ] 13.6 `G5` (S) — `cancel_job`, admin Automation section, transition-aware entry form.

## Phase 14 — Semantic + hybrid search (spec: design-search E4–E6) — evidence-gated

Ship only if dogfood shows keyword FTS quality is a real ceiling. (`E4` is
dependency-free and can slip into any idle slot earlier.)

- [ ] 14.1 `E4` (S) — BYO embeddings connector (OpenAI/Voyage; key encrypted,
      reference-only; mockable baseUrl for smoke).
- [ ] 14.2 `E5a` (M) — `entry_embeddings` (pgvector 1536 + HNSW) + `search:{semantic}`
      opt-in + indexHash invalidation + manifest round-trip (one-time manual
      `CREATE EXTENSION vector` on Neon).
- [ ] 14.3 `E5b` (M) — embed-on-write via defer + `sync_semantic_index` batched
      backfill. **Wire the G1 runner to automate resync loops** — closes the
      "semantic downtime on schema churn" weak spot.
- [ ] 14.4 `E6` (M) — semantic + hybrid (RRF) query modes on `search_entries` +
      delivery `?mode=`; `E_INDEX_STALE` refusal on zero coverage. Delivery
      semantic requires every searchable field publicRead (422 otherwise).

## Phase 15 — Payments (spec: design-payments)

Highest concrete tenant value of the remaining gaps. Stripe's own retry loop is
the durable queue — no hard G dependency, but land after G3 for clean logging.

- [ ] 15.1 `K1` (S) — Stripe connector (plain fetch, no SDK; pinned Stripe-Version;
      health = GET /v1/account).
- [ ] 15.2 `K2a` (M) — declarative checkout config on collections
      ({priceField, successUrl, cancelUrl}); `checkout` becomes a reserved name
      (**verify no production collection uses it first**).
- [ ] 15.3 `K2b` (M) — `POST /v1/checkout`: server-side price lookup (never trust
      client amounts), order entry created *before* the session (id in metadata),
      stripe-mock smoke harness.
- [ ] 15.4 `K3` (M) — signed webhook ingestion `/api/stripe/webhook/{projectId}`
      (whsec signature is the only auth; project identity from the verified path,
      never metadata). Migration: `project_connectors.secretsEnc` slot map.
- [ ] 15.5 `K4` (M) — order lifecycle: paid/expired CAS flips gated on
      `payment_status === 'paid'` (async methods mapped), declarative fulfillment
      via existing events; unmapped/probing events logged (rides G3's nullable column).
- [ ] 15.6 `K5` (S) — one-click webhook provisioning from the admin card.
- [ ] 15.7 `K6` (S) — checkout snippet in `get_client_code` + publishable-key exposure.

## Phase 16 — BYO-compute hooks + computed fields (spec: design-compute + corrections)

Closes "custom validation/transformation" **without hosting tenant code**.
Deliberately late: lands after the entries.ts churn has settled and dogfood
confirms tenant endpoints exist to call. *This design's revision pass did not
complete — the verifier-confirmed corrections are folded in below and override
the spec file where they disagree.*

- [ ] 16.1 `I1a` (M) — **validate-only** `beforeCreate` hook: HMAC-signed POST of
      the candidate entry to the tenant endpoint; `{ok} | {ok:false, error}`;
      strict timeout; fail-open/closed per config. Includes the delivery
      error-code plumbing verifiers demanded: `deliveryError` gains a code
      override so `E_HOOK_REJECTED` (422) / `E_HOOK_FAILED` (502) reach delivery
      clients distinctly. `hook.*` rows in webhook_deliveries + refire guard.
- [ ] 16.2 `I1b` (M) — transform mode + `beforeUpdate`: **https-only for transform;
      after any transform, re-stamp ownerField/org from the verified identity and
      re-strip on PATCH** (a hook can never move ownership); full re-validation
      of hook output via buildEntrySchema + verifyRefs; hooks join the manifest
      (import without a signing secret → imported `disabled:true` + warning,
      matching the semantic-search downgrade precedent).
- [ ] 16.3 `I2` (S) — `test_hook` dry-run MCP tool.
- [ ] 16.4 `I3` (M) — computed fields, closed vocabulary (slugify | template | now | uuid):
      **two explicit schema modes** — INPUT (rejects computed keys, applied to all
      untrusted input) vs STORAGE (post-stamp) — stamped in createEntry core
      **and bulkCreateEntries**; end-to-end create smoke.
- [ ] 16.5 `I4` (S) — computed recompute on update (source-field-triggered;
      `now on:'always'` restamps; CAS path documented as skipping).
- [ ] 16.6 `I5` (S) — hooks on bulk_create_entries **bounded to the host budget**:
      item cap sized so `ceil(n/5) × timeout + insert` fits ~8s; above it,
      E_VALIDATION with a "split the batch" hint. (Async bulk hooks ride G1 later.)
- [ ] 16.7 `I6` (S) — composition guide in get_project_info/get_client_code:
      hooks (sync) + events (async) + transact + jobs = business logic on YOUR infra.

## Phase 17 — Realtime change feed + SSE (spec: design-realtime)

Last on purpose: by now every mutation path exists (trash, restore, purge,
transact, workflow transitions) and the CAS pre-image is canonical — the feed
is written **once** against the final set instead of chasing it.

- [ ] 17.1 `H1` (M) — append-only `entry_changes` (bigserial cursor, write-time
      `vis` capture) + `get_changes` MCP tool. **Must cover all mutation paths
      incl. trash/restore/transact/transitions; `entry_changes` is the single
      tombstone mechanism** (entries_trash is storage, not a second feed).
- [ ] 17.2 `H2` (M) — `GET /v1/changes?since=` polling endpoint, then-AND-now
      privacy gating (write-time vis ∩ current rules — evaluated against F's
      preset-union shapes), ETag 304; `changes` reserved name (verify first).
- [ ] 17.3 `H3` (S) — collection-delete convergence: tombstones-first, disclosed
      in the delete plan.
- [ ] 17.4 `H4` (M) — SSE stream with bounded lifetime; Netlify degrade to
      long-poll documented; Render streams natively.
- [ ] 17.5 `H5` (S) — self-description + generated client code (poll/SSE/webhook
      positioning). Retention prune runs as a G1 job.
- **Honest positioning:** documented-lossy near-realtime pull (~2–4s worst case);
  sync-minded clients periodically reconcile with a full list GET.

## Phase 18 — Media transforms + i18n (spec: design-media-i18n)

Polish tier. `J1/J2` are self-contained — cherry-pick earlier if the dogfood
site needs srcsets.

- [ ] 18.1 `J1` (M) — on-demand image transforms `GET /v1/assets/{id}/image?w=&h=&fit=&format=`:
      sharp + R2-cached derivatives, 12-value size ladder, webp|jpeg.
      **Revisit the 40-derivative budget before shipping** — normal srcset usage
      consumes ~24; size it per-format or raise it (it's the load-bearing abuse bound).
      Verify sharp in a deploy preview (serverExternalPackages) — Render is risk-free.
- [ ] 18.2 `J2` (S) — transform discoverability in get_project_info + contentType
      on resolved assets.
- [ ] 18.3 `J3` (M) — project locales config + `set_locales` tool + manifest round-trip.
- [ ] 18.4 `J4` (M) — read-side localization plumbing, shipped inert (variant-map-safe
      delivery/admin/query before any localized field can exist).
- [ ] 18.5 `J5` (M) — `localized: true` goes live: strict per-locale validation,
      barred from labelField/templates/publicFilter/ownerField, **and barred from
      combining with `searchable` until search is locale-aware** (E×J conflict).
- [ ] 18.6 `J6` (S) — delivery `?locale=` with defaultLocale fallback.
- [ ] 18.7 `J7` (M) — admin locale switcher on entry forms.
- [ ] 18.8 `J8` (M) — localize/delocalize populated fields via wrap-backfill
      (delocalize = plan + confirm).

---

## Phase 19 — Neon connector (BYO database) — evidence-gated

Unchanged from the original plan: build only when an external tenant or a
data-ownership requirement demands it — the bridge into multi-tenancy.

- [ ] 19.1 Connection management / migration runner / data-plane routing (split)
- [ ] 19.2 Neon branching — preview environments ("branch, try migration, promote/discard")

## Phase 20 — Multi-tenancy (open the platform)

- [ ] 20.1 Workspace model — sign-up → workspace owns projects (extends project_members)
- [ ] 20.2 Isolation audit — every query provably project-scoped
- [ ] 20.3 Quotas/limits per workspace
- [ ] 20.4 Platform operator console (usage, health)

## Phase 21 — Plugins (extend the tool surface)

- [ ] 21.1 Plugin manifest format (tools contributed, connector dependencies)
- [ ] 21.2 Registry + per-project enablement
- [ ] 21.3 MCP tool proxying for plugin-contributed tools

---

## Infra track (parallel, slot as needed)

- [ ] Replace `unstable_cache` collection-metadata caching with a host-portable
      layer — **before** Phase 11 multiplies `getCollection` call sites.
- [ ] Durable rate-limit store (shared, serverless-safe) — automatically tightens
      E2 search, J1 transforms, K2b checkout when it ships; none block on it.
- [ ] Render move (when decided): jobs drain flips from Netlify scheduled fn to
      Render cron hitting the same endpoint; SSE gets native streaming; verify
      sharp + `ws` bundling.

## Test-harness notes

- `11-client-code.test.mjs` runs `tsc` via `execFileSync` (~19s, **blocks the event
  loop**), which outlives the dev server's 5s HTTP keep-alive timeout and leaves
  undici's pooled socket half-dead → first reuse resets (ECONNRESET). Wrapped the
  first post-compile delivery read in a `retryTransient` helper. Server is
  unaffected — a pure client-side stale-socket artifact.

## Engineering discipline (cross-phase contracts)

1. **lib/entries.ts churn order** is the sequence's backbone:
   A (validation edits) → B (`*Core` structural refactor) → C (trash/version
   hooks) → D/E (read helpers) → G4/I/H (write-path additions). Violating it
   means repeatedly rebasing the platform's single write choke point.
2. **One CAS pre-image mechanism.** B1 ships the advisory pre-read; C8's
   single-statement self-join supersedes it — refactor B1's path onto C8, G4b
   proves it under race, H consumes `prevData` from it. Never two implementations.
3. **New write paths call the `*Core` functions** so transact, hooks (I), and
   workflow enforcement (G4) compose automatically instead of leaking bypasses.
4. **webhook_deliveries becomes a multi-shape log** (`email:*`, `hook.*`,
   `embed:*`, `stripe:*`, schedule fires): refit the admin renderers when the
   second shape lands; every shape needs an explicit refire-guard decision;
   G3 owns making `collectionId` nullable.
5. **TOOL_DEFS drift**: the hand-written JSON inputSchema and its zod twin are
   maintained separately — nearly every increment touches both. Standing PR check.
6. **Reserved names**: `changes` (17.2) and `checkout` (15.2) join RESERVED_NAMES —
   verify no production collection uses those slugs before those phases.
7. **Migrations**: all additive, one `npm run db:push` per increment; keep the
   smoke-suite seed SQL in sync as schemas grow.

## What stays open (honest ledger)

Decisions, not omissions — each with its trigger to revisit:

- **Hosted compute** — closed by *reframe*, not by hosting: hooks + events +
  transact + jobs compose to full business logic on the tenant's infra. AgentX
  never executes tenant code. (Revisit: never, per design rule; the rejection stands.)
- **Per-row sharing/ACL** — F5 deferred, design recorded (entry_shares side-table).
  Trigger: a real project asking "share this doc with user X".
- **transact is MCP-only** — no atomic composite write on the delivery surface.
  Trigger: a public-site booking flow that can't be modeled with `update_entry_if`.
- **Payments = one-time checkout** — subscriptions, invoicing, refunds live in
  the tenant's app layer via Stripe directly. Trigger: recurring-billing tenant.
- **Localized fields aren't searchable/filterable** — the E×J intersection is
  barred at define time. Trigger: a multilingual site needing search.
- **requiredIf stays create-only** — ambiguous against merged rows; revisit with
  transact-era validation if it bites.
- **Field-level READ rules** — publicRead stays boolean; no claim-gated field
  projection. Trigger: dogfood evidence of "this field only for editors".
- **Workflows are single-entry** — multi-entry orchestration is the app layer's
  job (events + transact + jobs compose to sagas).
- **Realtime is near-realtime pull** — no websockets; documented-lossy feed +
  reconcile. Trigger: a tenant with true sub-second collaborative needs.

## Explicitly rejected (revisit only with strong evidence)

- **Server-side functions / sandboxed tenant code** — crosses the "CRUD +
  declarative behaviors" boundary; a product unto itself. Phase 16's hooks are
  the answer: tenant code runs on tenant infra.
- **Raw SQL escape hatch** — bypasses per-field public-read guarantees.
- **Hosted email engine** — email is a connector-backed action, never infrastructure we run.
- **An expression language for rules** — every authz/workflow/constraint knob is
  a parameterized preset; composition over expression.

## Deferred ideas (recorded, evidence-gated)

`content` token scope (entry CRUD without schema ops, for custom dashboards) ·
depth-2 relation expansion · avif/png transform formats · member-only checkout ·
per-role workflow actors (once F's claim vocabulary is proven) · async/after-write
hooks with retries (rides G1) · entry_changes as the unified webhook outbox.
