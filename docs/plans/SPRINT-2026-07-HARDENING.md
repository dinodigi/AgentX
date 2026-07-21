# Sprint — Hardening & closing the agent loop

> Initiative plan — written 2026-07-22. Status marks inline (⬜ / 🚧 / ✅).
> Theme: fix what is actively costing money and risking outages, then close
> the loop the field reports say is broken.

## Why this sprint (all evidence, no theory)

- **2026-07-21: total production outage.** Neon's control-DB compute quota was
  exhausted (a ~300-test smoke session was a large share). The blackout was
  amplified by our own health check, which reports 503 when the DB is
  unreachable — Render then restart-looped every instance, so *every* route
  502'd, including static marketing pages that need no database.
- ~~**The same health check is the monthly bill.**~~ ❌ **RETRACTED — this was
  wrong, twice over (found in the third audit pass, before any code):**
  1. `health/route.ts:18` queries the control DB **unconditionally**, before
     any status-code branch. Changing 503→200 does not stop the query, so it
     saves nothing.
  2. Even a zero-DB health endpoint wouldn't help: the **jobs-drain cron runs
     `* * * * *`** (`render.yaml:113`) and every tick hits the control DB four
     ways — `reclaimStale`, `tickSchedules`, `drainJobs`, `rollupUsage`. A
     query every 60s against a **5-minute** scale-to-zero threshold means the
     control DB can never idle, whatever the health check does.
  **OPS-3 is an availability fix only. It does not reduce the Neon bill.**
  Real cost reduction would mean drain cadence ≥ ~10 min (trading job/webhook/
  email latency for ~$12/mo) or moving the job queue off the control DB
  entirely. Both are product decisions, not part of this sprint.
- **Two Codex findings** from the plugin poke run: no MCP path to a delivery
  token (so `get_client_code` emits a client that can't run), and `enabled`
  reading as `applied`.
- **Four Stallion findings** filed 07-20, still untriaged — one of which looks
  like the fifth instance of our recurring config-staleness class.

## Track 1 — Stop the bleeding (do first; ~1 hour)

- ⬜ **OPS-3 — health liveness/readiness split.** *(Availability only — see the
  retraction above; this does NOT lower the bill.)* `/api/health` returns **200**
  with `{status:"degraded",db:"down"}` when the control DB is unreachable, so
  Render keeps the instance in rotation: static pages serve, APIs fail honestly
  per-request, the drain cron stays reachable. UptimeRobot still alerts (its
  keyword `"ok"` is absent from a degraded body). A genuinely hung process
  still restarts — no response at all trips Render's timeout.
  *Test:* simulate DB-down and assert 200 + degraded body + no `"ok"`.
  ✅ **Nothing is pinned to 503.** `55-health.test.mjs` asserts only the happy
  path (200/ok), which is unchanged. **One doc must be updated with the code:**
  `runbooks/STATUS-PAGE-SETUP.md:7` currently documents the 503 behavior.
- ⬜ **OPS-4 — dedicated test database.** ⚠️ **Bigger than "point the helpers at
  it" — audit found a split-brain risk.** The app reads `DATABASE_URL` in
  `db/index.ts:5` and `data-plane.ts:231`; the smoke helpers read the SAME var
  (`helpers.mjs:11`); and the suite reaches the app over HTTP via `SMOKE_BASE`,
  so **the app is a separate process with its own environment**. Changing only
  the helpers would have them writing to the test DB while the server still
  read production. The whole stack must share one test env:
  a `.env.test` holding the test `DATABASE_URL`, the **dev server started with
  it**, and the smoke runner using the same file.
  **Boundary to document:** `SMOKE_BASE=https://pluggie.app` (prod smoke) still
  hits production's DB by definition — a test DB cannot change that, so prod
  smoke runs stay deliberate and rare.
  **⚑ Needs the operator:** create one Neon project and hand over its
  connection string.
- ⬜ **Purge orphaned test projects.** 178 planless `smoke-*` projects survived
  failed/interrupted suites. Harmless to cost (control DB is 41 MB) but they
  clutter the fleet view. Then fix the leak: ephemeral cleanup must survive a
  failing suite.
  ✅ **Audit says this is safe:** **0 of the 178 hold `neon`/`r2` connectors**,
  so no cloud resources would be orphaned by deleting rows. They own 244
  entries, which cascade — 21 project-child FKs, all `CASCADE` except
  `platform_events` and `platform_feedback`, both `SET NULL` **by design** so
  the audit trail and the feedback wall outlive their project.

## Track 2 — Close the agent loop (the Codex findings)

- ⬜ **TOK-1 — mint/rotate delivery tokens over MCP.** Two independent reports.
  The sharp version: `get_client_code` generates a frontend client requiring a
  delivery token that no MCP tool can produce — the platform hands out code it
  won't let you run.
  ⚠️ **Security correction from the audit.** `mintToken`
  (`settings/actions.ts:102`) takes `scope: "mcp" | "delivery"` and **defaults
  to `"mcp"`**. Exposed naively, an MCP token could mint MORE MCP tokens —
  privilege-LATERAL, not downward, and it would defeat revocation (revoke one,
  the holder mints three more). **The MCP path must hard-restrict to
  `scope: "delivery"` and refuse anything else.** With that, "privilege
  downward" holds.
  Also: `mintToken` is gated on `requireOperator` → `getProjectRole`, which
  resolves a **Clerk session**. MCP has none, so this cannot be reused
  directly — the tool needs its own path authorized by the MCP token itself.
  *Test:* mint → works on delivery, refused on MCP; **minting an mcp-scope
  token over MCP is refused**; audit row carries the actor; revoke invalidates.
- ⬜ **PLUG-3 — `enabled` ≠ `applied`.** `list_plugins` gains an applied-state
  (`none` / `partial` / `full`, computed by checking baseline collection names
  against the project) plus an explicit `nextAction`. Also closes a Track C
  hole: we stamp the enabled VERSION but never whether the structure landed, so
  a never-applied plugin is indistinguishable from a fully-applied one in the
  session briefing.
  ⚠️ **Must read FRESH.** `listCollections` is cached (`collections.ts:46`,
  15s TTL) and its own comment records a live incident: *"a confirmed retype
  looked unapplied because the OTHER instance kept serving the old schema."*
  Computing applied-state from that cache could tell an agent "not applied"
  about a baseline it just applied — sending it to re-apply and trip the
  destructive-change gate, which is **worse than the confusion we're fixing**.
  Same standing rule as every other correctness read.

## Track 3 — Clear the Stallion four

- ⬜ **SEO title length measured on HTML-encoded text.** A 60-char title with
  two `&` reports as 68. Decode entities before measuring. (~20 min)
- ⬜ **`delete_asset` blocked by TRASHED rows.** ⚠️ **PLAN CORRECTED after code
  audit — my original fix was wrong.** `lib/r2.ts:416-424` ALREADY runs a
  separate trashed-row check with its own message ("N trashed entries … purge
  them first"). But Stallion received the **live-ref** message ("N entries
  still reference asset … clear those fields first"), which comes from the
  `entries` query at `:405-412`. So either their blockers were genuinely live
  rows, or something leaves soft-deleted rows in `entries`. **Investigate
  which path fired before changing anything.** The part of their ask that
  survives regardless: neither message names the referencing **collection**,
  only a count — add that.
- ⬜ **Workflow actions don't fire right after a redefine.** *The headline.*
  ⚠️ **My cache-lag hypothesis is NOT supported by the code.** `update_entry`
  reads config via `mustCollection` → `getCollection`, whose TTL is
  **15 seconds** (`lib/collections.ts:46`) — that does not explain a miss
  ~60 seconds after the define. Drop the confident "fifth staleness instance"
  framing. Candidates to test, in order:
  1. `fireTransition` is **deferred** (`lib/events.ts:261`) — fire-and-forget
     after the response; a recycled instance could drop it silently.
  2. Next's `unstable_cache` can serve **stale-while-revalidate** past the TTL,
     so 15s is a floor, not a ceiling.
  3. The `event_action` job handler **skips silently** when the action hash no
     longer matches current config ("edited since enqueue").
  **Reproduce first.** No fix until one of these is demonstrated.
- ⬜ **Thumbnail burst rate-limiting.** First-request derivative generation is
  confirmed by design (`app/api/v1/assets/[id]/image/route.ts` header: resize →
  R2-cached derivative → 302). **Not** confirmed: which limiter produced their
  429s — that route shows no `rateLimit` call, so the throttle may come from
  elsewhere. Find the actual limiter before choosing between eager
  thumbnail-at-upload and `503 + Retry-After`.

## Code audit — 2026-07-22 (before writing any code)

Every claim above was checked against the source. Result: **5 verified, 1
wrong, 1 hypothesis contradicted, 1 partial.**

| Claim | Verdict |
|---|---|
| `/api/health` 503 + `healthCheckPath` points at it | ✅ `health/route.ts:28`, `render.yaml:37` |
| Degraded body has no `"ok"` (UptimeRobot keyword stays red) | ✅ body is `{status:"degraded",db:"down",latencyMs}` |
| Smoke suite runs against the PRODUCTION control DB | ✅ `helpers.mjs:11` uses `DATABASE_URL` from `.env` |
| No MCP tool can mint a delivery token | ✅ none in `TOOL_DEFS`; `mintToken` is admin-only (`settings/actions.ts:102`) |
| `list_plugins` has no applied-state | ✅ nothing in the codebase |
| SEO title measured on encoded text | ✅ raw regex extract (`seo.ts:92`), no decode, `h.title.length` (`:196`) |
| `delete_asset` mishandles trashed rows | ❌ **wrong** — a dedicated trashed check already exists; wrong path diagnosed |
| Workflow miss = config cache lag | ⚠️ **contradicted** — 15s TTL doesn't explain a 60s-later miss |
| Thumbnail 429s come from the image route's limiter | ⚠️ **partial** — generation confirmed, limiter source not found there |

Lesson worth keeping: the two items I stated most confidently were the two
that were wrong. Field reports describe **symptoms**; the plan may not assume
a **cause**.

## Deliberately NOT in this sprint

- **Blueprints (Plugin Phase 2)** — gated on a clean poke pass; the run is
  still in flight.
- **Feedback issues-layer, XVibe** — parked by operator decision.
- **MT-1 (scoped MCP tokens)** — the largest latent security gap (one
  all-powerful token bypasses row isolation). Too big to bolt on here;
  **nominate it to lead the next sprint.**

## Success criteria

1. A control-DB outage degrades the platform instead of blacking it out —
   provable by simulating DB-down and still serving the marketing site.
2. ~~Monthly cost roughly halves.~~ **Removed — retracted above.** The
   every-minute drain cron keeps the control DB awake regardless; cost is the
   price of a responsive job queue, not a bug.
3. Smoke runs touch no production database.
4. An agent can go from empty project → generated client → working delivery
   calls without leaving MCP.
5. `list_plugins` makes the enabled/applied distinction obvious.
6. The wall's `new` column is empty again, with each fix reproduced first.
