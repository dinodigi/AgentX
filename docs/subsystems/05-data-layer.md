# 05 · Data layer (grade A-)

Purpose: the strict core — schema as data, validation an agent can't defeat.
The remaining work is the bottom of the business-logic ladder.

## Sub-features

- [ ] **Field constraints** (M) — `unique` (partial index on
      (collection_id, data->>field)), `min`/`max` (numbers + string length),
      enum-dependent required. Strengthens the "can't corrupt" promise.
- [ ] **update_entry_if** (M) — atomic compare-and-set + guarded increment in
      one SQL statement. The 80/20 of transactions (book-a-seat) with zero
      code execution. Exposed as tool + future ctx primitive.
- [ ] **Rename migration** (M) — `rename: {from,to}` in define_collection's
      plan/confirm flow with data backfill; today a rename strands data.
- [ ] **Multi-relation / has-many** (L, dogfood-gated) — the ninth field
      shape; wait for the real-site friction log to confirm.
- [ ] **transact([ops])** (L, evidence-gated) — declarative multi-op atomic
      batch; rung 4 of the ladder, prerequisite for hosted functions if ever.

Done when: an agent can model a bookings-with-capacity app with correctness
guaranteed by the platform, not by its own care.
