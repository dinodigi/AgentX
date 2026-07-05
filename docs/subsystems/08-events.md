# 08 · Events (grade B-)

Purpose: declarative automation. Lifecycle → webhook/email with retry+log
exists; the gaps are precision and self-service debugging.

## Sub-features

- [ ] **Conditional actions** (S/M) — `when: WhereClause[]` on any action
      ("email only when status becomes confirmed"); reuses 04's validated
      clause machinery against the entry snapshot.
- [ ] **Manual re-fire** (S) — replay a failed delivery from the log (admin
      button + tool); today a failed webhook is visible but dead.
- [ ] **Per-action enable/disable** (S) — pause an action without deleting it.
- [ ] **Old/new snapshot in updated events** (S) — payload includes changed
      fields so receivers don't diff blindly.
- [ ] **Digest/batching** (M, defer) — "daily summary email" shape; wait for
      demand.
- [ ] **Function action** (gated, Phase 6) — {type:"function"} per the hosted
      logic architecture; do not build before its platform trigger.

Done when: "notify X when Y becomes Z" is one declarative line, and a failed
notification can be diagnosed and replayed by the agent that set it up.
