# Gap-closing design specs

Produced 2026-07-07 by a multi-agent design pass (7 subsystem readers → 11 gap
designers → 2 adversarial verifiers per design → revision → completeness critic
+ sequencer). Each `design-*.json` is the **implementation-grade spec** for one
platform gap: approach, key decisions with rejected alternatives, and S/M-sized
increments with concrete files, surfaces, and migrations.

| File | Gap | Roadmap phase |
|---|---|---|
| design-constraints.json | Field constraints (pattern, bounds, unique-on-date, null-unset) | 8 |
| design-atomicity.json | CAS completion + `transact([ops])` | 9 |
| design-versioning.json | Trash / restore / version history | 10 |
| design-query-power.json | Relation expansion + related-field filters | 11 |
| design-search.json | Keyword FTS (11) + semantic/hybrid (14) | 11, 14 |
| design-authz.json | Claim rules, any-of presets, org scoping, field-level writes | 12 |
| design-time-flow.json | Jobs runner, delayed actions, schedules, workflows | 13 |
| design-payments.json | Stripe connector + declarative checkout | 15 |
| design-compute.json | BYO-compute hooks + computed fields — **read with ROADMAP Phase 16 corrections; this design's revision pass did not complete** | 16 |
| design-realtime.json | Change feed + SSE | 17 |
| design-media-i18n.json | Image transforms + localized fields | 18 |
| **design-data-plane.md** | Per-project data plane (control vs tenant split, resolver seam, migration runner, BYO/managed provisioning, dev/prod envs) — **A0 draft, pending review**; markdown, not JSON | 19 / Track A |

Also here:

- `subsystem-map.md` — the fresh code map (file:line extension points, invariants,
  gotchas) all designs were grounded in. Useful session bootstrap.
- `critique.json` — completeness critic: what NO design covers (the honest ledger
  in ROADMAP.md is derived from this), weak spots, and the 9 cross-design
  conflicts.
- `sequence.json` — sequencer output: phase rationale + the engineering-discipline
  notes (choke-point ordering, CAS pre-image convergence, multi-shape delivery log).

**Caveats:** `design-constraints.json` and `design-compute.json` are pre-revision
(their revision agents died on transient errors); their verifier-confirmed fixes
are folded directly into ROADMAP.md phases 8 and 16 — the roadmap text wins where
it disagrees with those two files. All other designs are post-revision.
