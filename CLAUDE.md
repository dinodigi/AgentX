# CLAUDE.md — session rules for this repo

Pluggie (AgentX): MCP-native backend platform. Live at pluggie.app (Render,
push-to-master auto-deploys). Repo map in README.md; doc story in docs/README.md.

## Build & deploy (hard rules)

1. **Always `npm run build` before pushing master** — tsc alone misses Next
   route-file export rules, and master auto-deploys.
2. **Never `next build` while a dev server is running** — they share `.next`;
   every request 500s until restart. Stop the dev server, build, restart.
3. `npm run db:push` is **broken against Neon PG18** — apply schema changes by
   hand (SQL on the control DB; tenant tables via the migration gate).
4. Smoke tests run against a live dev server:
   `SMOKE_BASE=http://localhost:<port> node --env-file=.env --test scripts/smoke/<file>`.
   Full suite: `npm run verify`.

## Doc-sync ship ritual

When a batch changes the **MCP tool surface** or **platform behavior**, before
pushing:

1. Regenerate the AI contract:
   `npx tsx --conditions react-server --env-file=.env scripts/dump-contract.ts`
2. Update the relevant section of `docs/CAPABILITIES.md` and bump its
   `Living — last synced` dateline.
3. Reconcile `docs/BACKLOG.md`: add anything raised-but-parked, strike/annotate
   anything shipped (commit hash in the note).
4. Plan docs (`docs/plans/`) get inline status marks; `docs/reviews/` and
   `docs/archive/` are dated records — never rewrite them after the fact.

Doc classes: every top-level doc opens with a dateline (`Living — last synced`,
`Durable`, `Contract`, or it's a dated record by folder). Convention details in
docs/README.md.

## Conventions

- Correctness gates read FRESH from the DB, never through a cache
  (destructive-change gate, relation-target validation are precedents).
- Every `unstable_cache` carries a `revalidate` TTL (multi-instance fleet —
  revalidateTag alone is per-instance).
- When hitting a platform limitation while building on Pluggie, call the
  `send_feedback` MCP tool — the feedback wall is the operator's triage queue.
