# Sprint — Field signal: fix what more than one tester hit

> **SPRINT PLAN**, written 2026-07-26. Status marks inline (⬜ / 🚧 / ✅).
> ⚑ = needs the operator.
>
> Built from the **32 open wall items** (15 new on 07-26 from `jabed test` and
> `xvibe`, 17 carried from 07-18→07-24), not from memory or taste.
>
> **The organizing rule: prioritise by INDEPENDENT CONFIRMATION.** Five issues
> were reported by two or more testers who never spoke to each other, some
> eight days apart. A repeat report is the closest thing to proof that an issue
> is structural rather than one integrator's unusual path — so Track A is
> "everything ≥2 people hit", and it is ordered by how much damage the
> misunderstanding causes, not by effort.
>
> Predecessors: `MCP-FRICTION-PLAN.md` (A–D shipped; OAuth live 07-26),
> `SPRINT-LOOSE-ENDS.md` (A/E done; G open).

## Track A — Reported independently by 2+ testers (do these first)

- ✅ **A1 — `admin` workflow actor silently includes client-role members.** **SHIPPED 2026-07-26.** `WorkflowActor` gains `operator` (workspace members + platform operators — real staff) and `client` (invited project members); `admin` is kept as a DEPRECATED permissive alias meaning either, so every existing `actors:['mcp','admin']` workflow behaves identically on deploy — asserted by test. `AuditActor.admin` now carries `role`, so the audit trail can finally answer "was that staff?". The admin write path stamps it via `getProjectRole`, which already drew exactly the right line. Asymmetry is deliberate: `admin` accepts operator+client, but `operator` does NOT accept a bare `admin`, so a staff-only gate is real. Tool description rewritten with the warning in capitals. 12/12 workflow suite.
  🔴 **The only item here that is security-shaped, and it has now been reported
  TWICE, 8 days apart** (CSLP 07-18: *"workflow actors are too coarse"*; jabed
  07-26: *"deserves far more prominence than a parenthetical, or its own
  actor"*).
  **Verified 07-26:** `app/admin/actions.ts` stamps `actor: {type:"admin"}` for
  **any** viewer who reaches the admin write path, and `getProjectRole` returns
  `"client"` for project members. So `actors: ["mcp","admin"]` does **not** mean
  staff-only. It IS documented — as a `NOTE` inside a tool description — but the
  word *gated* invites exactly the wrong reading.
  *The damage:* someone who reads it as an authorization boundary has a
  privilege escalation they will not discover until it is used.
  **Fix (design first, small code):** split the actor vocabulary so
  `operator` ≠ `client`, keeping `admin` as a deprecated alias that still means
  both, so no live workflow changes behavior on deploy. Loud copy in the tool
  description either way.
- ⬜ **A2 — Two read planes disagree, and only schema says so.**
  Hatchly 07-24 + jabed 07-26 (+ our own G2). MCP reads are fresh; the delivery
  API converges ~15s later **and** enforces `publicFilter`, so a just-published
  row is briefly invisible to its own author.
  **The actionable half is new and cheap:** `define_collection` returns a
  `convergence` note, but **entry writes return nothing** — so the silence after
  `update_entry` reads as a bug. jabed lost debugging time to exactly that.
  *Fix:* extend the convergence note to entry mutations; document the
  `publicFilter` asymmetry in the same breath.
  🔗 **Third independent signal on the cache TTL** (with the outside review and
  our own carve-outs). Measure a 2s TTL before adding a fourth carve-out.
- ⬜ **A3 — `indexed` rejected on date fields.**
  Fatsoz 07-20 + jabed 07-26. Both said the same thing: the error message is
  *good*, but the suggested workaround ("index another dimension") has no
  substitute for the case that triggers it. `published_at` is the canonical sort
  key for content; `starts_at`/`ends_at` are the canonical filter for scheduling.
  *Fix:* support `indexed` on date fields (an expression index over the
  normalized instant), or state plainly that it will not be supported and why.
- ⬜ **A4 — Stateless MCP-over-HTTP is undocumented.**
  **THREE reporters** — Hatchly, Fatsoz 07-20, jabed 07-26 — each discovered by
  *probing* that `tools/call` works with no handshake and no session id, and
  each called it a significant integration advantage. jabed avoided adopting the
  MCP SDK entirely and wrote a 40-line fetch client.
  *Fix:* document it as supported (BACKLOG DX-5), in `get_project_info`
  orientation and the contract. Cheapest item in the sprint; three people paid
  for the discovery.
- ⬜ **A5 — Anonymous intake cannot coexist with gated writes.**
  CSLP 07-18 (*"docs say publicWrite POST is anonymous, but a tokenless POST
  returns 401"*) + xvibe 07-26 (*"any non-none `access.write` replaces the
  anonymous POST path — forcing a two-collection split for the classic public
  form in, staff triage desk"*).
  This is the single most common shape in every project on the platform, and it
  currently requires splitting one collection into two.
  *Fix:* decide whether `publicWrite` and `access.write` compose (anonymous
  POST + gated PATCH/DELETE) rather than replace. Design call, then code.

## Track B — Cheap ergonomics (a day, high volume of papercuts)

Each is small, each cost a real integrator real time, and none needs a design
decision.

- ⬜ **B1 — `bulk_create_entries` vs `create_entry` shape asymmetry.** One takes
  bare objects, the sibling takes `{collection, data:{…}}`. jabed carried the
  shape across and failed all 14 items. *Accept both shapes*, and fix the error
  ordering — it leads with "key: Required" (a downstream symptom) instead of the
  unrecognised `data` key (the actual cause).
- ⬜ **B2 — Typed-block sub-fields reject explicit `null`.** A block editor
  naturally emits `null` for "nothing selected"; the fix is to omit the key, but
  `Expected string, received null` reads like a type error. *Accept null as
  absent for optional relation/asset sub-fields, or say "omit the key" in the
  hint.* Bit jabed twice — once seeding, once in the editor they shipped.
- ⬜ **B3 — `query_entries` rejects `id` in where clauses** (Hatchly 07-20).
- ⬜ **B4 — MCP-path errors use delivery-facing wording** (CSLP 07-18).
- ⬜ **B5 — `increment` refuses an unset field** (jabed 07-26). The
  seed-or-fallback workaround has a race that **silently loses the first
  count**. *Add `startingFrom`/upsert semantics* so the first increment is
  atomic.

## Track C — The scaling traps (works at demo scale, fails after commitment)

- ⬜ **C1 — Array fields cannot be filtered on the delivery API.** jabed's tag
  archive fetches every post and filters in memory: *"correct at 5 posts and
  wrong at 500"*. The generated client's filter type advertises `tags`, which
  implies otherwise. Worst failure profile on the board — it ships fine and
  breaks after a customer has invested.
- ⬜ **C2 — `publicFilter` cannot express relative time.** jabed: a campaign
  stays served up to an hour past its contracted end. **Note the inconsistency
  they caught: `define_schedule` already accepts a `{daysAgo}`-style vocabulary**
  — the language exists, it just is not available here.
- ⬜ **C3 — No date bucketing / second `groupBy` dimension** (CSLP 07-18) — the
  by-month report pipeline. Long-standing, still open.

## Track D — Design decisions (needed before code, ⚑ operator input)

- ⬜ **D1 — `auth_kit` leaves credentials to every tenant.** jabed's report is
  the most thorough on the wall: they had to choose argon2id parameters, build
  lockout, and — the subtle one — use a **real** dummy hash on unknown emails so
  response latency does not enumerate accounts. *"Subtle enough that I would
  expect many integrators to miss it."* They are right, and a first version that
  misses it leaks silently.
  ⚑ **The decision is strategic, not technical:** does Pluggie store credential
  material (breaking "credential-free by design"), ship a verified reference
  implementation, or stay out and document the trap loudly? All three are
  defensible; the current position is the only one that is *silently* dangerous.
- ⬜ **D2 — Workflow transitions gate on WHO, never on WHAT.** jabed: cannot say
  "may not go live without a creative", so the rule becomes a required field —
  which then blocks saving a draft. The constraint lands at the wrong moment.
  *Design:* transition preconditions (`when` clauses already exist as a
  vocabulary elsewhere).
- ⬜ **D3 — A browser-safe delivery credential.** Codex 07-23 (DX-7) + xvibe
  07-26, which is the sharper version: **XVibe now runs an edge proxy per app
  for the sole purpose of holding the token.** A read-only + publicWrite-only
  credential class would let static bundles call the delivery API directly and
  delete that proxy.
  ⚑ Interacts with CDN cache keys, rate limiting, and abuse surface — needs its
  own design pass, but it now has two reporters and a concrete workaround cost.

## Track E — Bugs (verify, then fix)

- ⬜ **E1 — `briefing.health` reports connectors as `error` while they work.**
  xvibe 07-26: R2 shows `error` in the briefing while `upload_asset` succeeds
  and the returned public URL serves 200.
  **Partially verified 07-26:** all four connector rows for that project read
  `status = connected` in the control DB, so the briefing is reporting something
  other than stored state. *Reproduce before fixing* — check whether
  `listConnectors` is serving a stale cache or computing status differently.
- ⬜ **E2 — `get_client_code` omits `update()`/`remove()` for claim-write
  collections.** xvibe 07-26: a collection with `access.write: {claim…}` got
  only list/get/create, though the docs say a matching claim-write enables
  PATCH/DELETE on any row. Either the generator is wrong or the docs are —
  find out which before changing either.

## Not in this sprint (deliberate)

- **Refresh-token rotation** for OAuth. Mandatory under OAuth 2.1 for public
  clients; 90-day access tokens hold until it gets its own pass.
- **PLUG-4 realized-names write side** — the column exists; the "when is an
  apply finished?" design question is unanswered.
- **Adversarial concurrency tests** and the **cache TTL measurement** — both
  genuinely valuable, both never started. Backlog, not loose ends.
- **Elastic Email send proof** — parked by the operator; nothing depends on it.

## Success criteria

1. No issue reported by two independent testers remains open (Track A).
2. An integrator's first hour produces no papercut that a better error message
   would have prevented (Track B).
3. Every "works at demo scale" trap either has a real answer or a documented
   limit stated **before** a customer invests in it (Track C).
4. The two open bugs are reproduced first, then fixed — never fixed from the
   report's narrative (CLAUDE.md rule; it has caught us four times).
