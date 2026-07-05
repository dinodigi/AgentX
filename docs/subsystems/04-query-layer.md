# 04 · Query layer (grade B)

Purpose: what questions the data can answer. Filters/sort/count exist; real
app screens need more shapes.

## Sub-features

- [ ] **aggregate_entries** (M) — sum/avg/min/max over number fields +
      group-by enum/relation, same validated-clause discipline. Unlocks
      dashboards ("revenue by trip") without fetch-everything.
- [ ] **`in` operator** (S) — value lists for enum/relation/text.
- [ ] **OR groups** (M) — one nesting level only: `anyOf: [clauses]`. Keep it
      declarative; no expression language.
- [ ] **Cursor pagination** (S/M) — stable ordering + opaque cursor; offset
      breaks past a few thousand rows.
- [ ] **Field selection** (S) — `select: [fields]` on queries and delivery GET;
      trims payloads for list views.
- [ ] **Relation depth** (M, defer until a real site needs it) — populate one
      extra level with an explicit fields whitelist; unbounded depth stays out.

Done when: the standard screens of a small SaaS (filtered lists, dashboards,
detail pages) each cost exactly one query.
