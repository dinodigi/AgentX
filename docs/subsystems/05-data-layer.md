# 05 · Data layer ✅ DONE 2026-07-05 (gated items unchanged)

Purpose: the strict core — schema as data, validation an agent can't defeat.
Ladder rungs 1–2 built; rungs 3–4 stay evidence-gated.

## Sub-features

- [x] **Field constraints** (M) — `unique` (partial unique index per field,
      synced before the schema row persists; 23505 mapped to a field-named
      hint), `min`/`max` (number values / text lengths), `requiredIf`
      enum-dependent required. Strengthens the "can't corrupt" promise.
- [x] **update_entry_if** (M) — atomic compare-and-set + guarded increment in
      one SQL statement (if-conditions + min/max guards in the UPDATE's WHERE;
      increment computed in SQL). E_CONFLICT on mismatch. Verified: 5 parallel
      bookings against 3 seats → exactly 3 win.
- [x] **Rename migration** (M) — `renames: [{from,to}]` in define_collection;
      diff reports renames, data backfilled atomically, unique indexes move
      with the field. No confirm (nothing lost); drop+add still gates.
- [ ] **Multi-relation / has-many** (L, dogfood-gated) — the ninth field
      shape; wait for the real-site friction log to confirm.
- [ ] **transact([ops])** (L, evidence-gated) — declarative multi-op atomic
      batch; rung 4 of the ladder, prerequisite for hosted functions if ever.

Done when: an agent can model a bookings-with-capacity app with correctness
guaranteed by the platform, not by its own care.
