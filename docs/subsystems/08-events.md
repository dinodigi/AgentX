# 08 · Events ✅ DONE 2026-07-05 (gated items unchanged)

Purpose: declarative automation. "Notify X when Y becomes Z" is one
declarative line, and a failed notification can be diagnosed and replayed by
the agent that set it up — the done-when, verbatim.

## Sub-features

- [x] **Conditional actions** (S/M) — `when: [clauses]` on any action, same
      validated shape as query where (define-time buildWhere, emit-time
      matchesClauses against the post-change snapshot).
- [x] **Manual re-fire** (S) — refire_delivery tool + Re-fire button on failed
      rows in the settings log. Webhooks re-post the stored payload; emails
      re-send the render (now stored with each log row). Replays are NEW rows.
- [x] **Per-action enable/disable** (S) — disabled: true pauses an action,
      schema keeps it; toggle by redefining.
- [x] **Old/new snapshot in updated events** (S) — updated payloads carry
      {previous: {data}, changedFields} (from updateEntry; update_entry_if
      omits previous — it deliberately never reads before writing).
- [ ] **Digest/batching** (M, defer) — "daily summary email" shape; wait for
      demand.
- [ ] **Function action** (gated, Phase 6) — {type:"function"} per the hosted
      logic architecture; do not build before its platform trigger.

Done when: "notify X when Y becomes Z" is one declarative line, and a failed
notification can be diagnosed and replayed by the agent that set it up.
