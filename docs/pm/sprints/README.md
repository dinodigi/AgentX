# Sprints

Sprint plans live in **[../../plans/](../../plans/)** — they are linked from
commits and memory, so they stay put. This folder indexes them by date and
records the outcome once a sprint closes.

| Sprint | Dates | Plan | Outcome |
|---|---|---|---|
| **Field signal** | 2026-07-26 → | [SPRINT-FIELD-SIGNAL.md](../../plans/SPRINT-FIELD-SIGNAL.md) | 🚧 active — 15 tasks, 5 tracks, prioritised by independent confirmation |
| Loose ends | 2026-07-25 | [SPRINT-LOOSE-ENDS.md](../../plans/SPRINT-LOOSE-ENDS.md) | ✅ mostly — A (drift) + E (wall) done; C parked; F1 promoted to its own sprint; G carried into Field signal |
| MCP friction | 2026-07-23 → 07-26 | [MCP-FRICTION-PLAN.md](../../plans/MCP-FRICTION-PLAN.md) | ✅ complete — A/B/C shipped and field-validated; D1/D2/D3 shipped, **OAuth live 07-26** |
| 2026-07 hardening | 2026-07-22 | [SPRINT-2026-07-HARDENING.md](../../plans/SPRINT-2026-07-HARDENING.md) | ✅ 9/10 — OPS-3 health split, OPS-4 test DB, TOK-1 tokens, PLUG-3, thumbnails, SEO; EE send proof parked |
| XVibe (parallel) | 2026-07-25 → | [XVIBE-PLAN.md](../../plans/XVIBE-PLAN.md) | 🚧 handed off to its own session with `docs/xvibe-brief/` |

## Closing a sprint

1. Mark every item ⬜/🚧/✅ in its plan doc — including what did **not** land.
2. Disposition the wall rows it resolved, **with receipts** (`npm run pm` to
   verify the count dropped).
3. Add the outcome row above.
4. Update [../STATUS.md](../STATUS.md).
