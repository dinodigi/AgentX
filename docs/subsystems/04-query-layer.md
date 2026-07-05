# 04 · Query layer ✅ DONE 2026-07-05 (relation depth stays deferred)

Purpose: what questions the data can answer. Built smallest-first so
aggregate_entries landed on the finished where vocabulary.

## Sub-features

- [x] **aggregate_entries** (M) — count/sum/avg/min/max over number fields +
      group-by enum/relation (relation groups resolve labels), same
      validated-clause discipline, full where vocabulary. Groups capped at
      500 largest-first with truncatedGroups flag.
- [x] **`in` operator** (S) — value lists for enum/relation/text; both
      directions guarded (empty lists, arrays on scalar ops).
- [x] **OR groups** (M) — one nesting level only: `anyOf: [clauses]`; works
      in where and publicFilter (SQL + JS row gates).
- [x] **Cursor pagination** (S/M) — opaque (createdAt, id) keyset cursor over
      the default ordering; ms-truncated both sides (JS Dates lose PG
      microseconds); excludes offset/orderBy with fix hints.
- [x] **Field selection** (S) — `select: [fields]` on query_entries and
      ?select= on delivery GET (public fields only, id always kept).
- [ ] **Relation depth** (M, defer until a real site needs it) — populate one
      extra level with an explicit fields whitelist; unbounded depth stays out.

Done when: the standard screens of a small SaaS (filtered lists, dashboards,
detail pages) each cost exactly one query.
