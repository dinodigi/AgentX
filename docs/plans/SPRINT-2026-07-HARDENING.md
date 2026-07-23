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
- **2026-07-22: Elastic Email cannot be connected at all.** Operator report,
  reproduced against the live DB and the live EE API — the second provider in
  the email category is unreachable in practice, so "either or" is currently
  "Resend only." Details in EE-1.
- **Four Stallion findings** filed 07-20, still untriaged — one of which looks
  like the fifth instance of our recurring config-staleness class.

## Track 1 — Stop the bleeding (do first; ~2 hours incl. EE-1)

- ✅ **OPS-3 — health liveness/readiness split.** *(Availability only — see the
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
  ⚠️ **Accepted tradeoff, write it down:** a 200-degraded health check also
  passes the gate for a *fresh deploy* whose `DATABASE_URL` is wrong or
  missing. Today that deploy fails its health check and is held back; after
  OPS-3 it rolls out and serves degraded. That is the intended exchange
  (availability over gatekeeping), but it must be in the runbook so nobody
  rediscovers it mid-incident.
  ✅ **DONE 2026-07-22.** `app/api/health/route.ts` returns 200 + `{status:
  "degraded",db:"down",deep,latencyMs}` on control-DB failure; the header
  documents the incident and the tradeoff. **Verified by simulation, not
  assumption:** `scripts/verify-health-degraded.mjs` (new — points the real
  handler at an unreachable DB) asserts 200 + degraded body + **no `"ok"`
  substring** + `no-store`, on both `/api/health` and `?deep`. Happy path
  re-run green (`55-health.test.mjs`, 2/2); `tsc --noEmit` clean.
  ✅ **Criterion-1 half also checked:** no marketing page or root layout imports
  `@/db`, so with the instance staying in rotation, static pages genuinely do
  serve through a control-DB outage.
  ✅ **Docs synced:** `runbooks/STATUS-PAGE-SETUP.md` rewritten — the signal
  section, the incident rationale, the tradeoff, and a hard instruction that the
  monitors must be **KEYWORD** monitors (a status-code monitor is now blind to a
  DB outage). `55-health.test.mjs` header points at the degraded-path script.
  ⚑ **Operator follow-up:** confirm the two UptimeRobot monitors match on the
  keyword `ok` and NOT on the status code — otherwise a real DB outage now goes
  unalerted. `/api/v1/_health` is unaffected (it touches no DB).
- ⬜ **OPS-4 — dedicated test database.** ⚠️ **Bigger than "point the helpers at
  it" — audit found a split-brain risk.** The app reads `DATABASE_URL` in
  `db/index.ts:5` and `data-plane.ts:231`; the smoke helpers read the SAME var
  (`helpers.mjs:11`) — **and so does every test file that opens its own client:
  at least ten do (`18-trash`, `21-search`, `23-jobs`, `24`, `25`, `28`, `30`,
  `33`, `34`, `35`), each calling `neon(process.env.DATABASE_URL)` directly.**
  One env file still covers them all, but the acceptance check is "no test file
  resolves a production connection string", not "the helpers point elsewhere".
  The suite also reaches the app over HTTP via `SMOKE_BASE`,
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
  *Re-confirm the counts at execution time* — they came from a live control-DB
  query, which is the thing OPS-4 exists to stop doing.
  🚧 **2026-07-22 — leak FIXED; the mass delete is still pending.**
  ✅ **The leak (the half that matters).** `destroy()` only runs if a suite
  reaches its `after()` hook, so a crash, a throw before `after`, or a Ctrl-C
  stranded the project permanently. `createEphemeralProject` now sweeps stranded
  rows on create (`scripts/smoke/helpers.mjs`) — the same opportunistic pattern
  as trash retention and audit pruning, no new job to remember. Two guards:
  rows must match the EXACT minted shape `^smoke [a-z0-9-]+ [0-9]{13}$`, and be
  older than 2h so a running suite can never sweep its own live fixtures.
  Bounded to 25 per call. Predicate validated READ-ONLY against production.
  ⚠️ **Re-audit changed two numbers** — always re-check before a mass delete:
  now **185**, not 178; and one `resend` connector now sits among them (a stored
  fake `re_smoke_key`, not a provisioned resource — the neon/r2 criterion that
  actually matters is still zero).
  🛑 **`plan IS NULL` alone would be CATASTROPHIC.** 197 projects are planless,
  including Pluggie Marketing, Havn, Vendor Hub, Codex and Tidewater. The NAME
  SHAPE is the load-bearing guard, not the plan column. Verified: 12 planless
  non-smoke projects and 0 wrong-shape smoke names are protected by it.
  ⬜ **The one-off delete of the existing 185 was BLOCKED** by the permission
  classifier and deliberately not routed around. It is also no longer urgent:
  the new sweep drains the backlog automatically over the next `npm run verify`.
  Operator can grant the permission for a one-shot, or just let the sweep run.
- 🚧 **EE-1 — Elastic Email is unreachable as a provider.** Operator report
  2026-07-22, **reproduced against both the live DB and the live EE API**. The
  email category was built as either/or; in practice only Resend is reachable.
  Four distinct defects, in the order they bite:
  1. **Nothing is connected, anywhere.** `project_connectors` holds **12 email
     rows, all `resend`, zero `elastic_email`** across every project. The
     connection never persisted.
  2. **Connect-time refusal with no swap path.** `categoryConflictRefusal`
     (`lib/connectors.ts:231`) runs FIRST in `saveConnector`
     (`settings/actions.ts:202`), before the key or from-address is even read.
     Every project already has Resend, so **every** Elastic Email save is
     refused — the operator hit this with a full-access key. The one-provider
     rule is right; the missing piece is an explicit **switch provider** action
     on the email card, instead of "go disconnect the other one first."
  3. **The health probe's 403 branch is dead code.** `lib/providers/email.ts:137`
     treats 403 as "valid but send-only scope", so a narrow key doesn't show a
     false red dot. **Elastic Email never returns 403 here.** Probed live three
     ways — bad key + both headers, bad key + `X-ElasticEmail-ApiKey` only, and
     no auth at all: **all three return HTTP 400 `{"Error":"APIKey Expired"}`**.
     So the branch cannot fire, and the probe reports a bare "returned HTTP 400"
     while discarding EE's actual message. Fix: **parse the `Error` body**, don't
     branch on status. (Sending both auth headers is harmless — verified they
     behave identically.)
  4. **Connect never validates the key.** `verifyKey` is called only by
     `rotateConnectorSecret` and `checkConnectorHealth` — never on connect. So a
     save proves nothing and the failure surfaces at first send. Compare Clerk,
     which probes JWKS before saving on the stated principle that *"a connector
     that never worked shouldn't say connected"* (`settings/actions.ts:228`).
     Email should hold the same line.
  ⚠️ **The v4 wire shape is still UNVERIFIED end-to-end.** `91-email-providers`
  uses the fake key `ee_smoke_key` and only asserts the error text says "Elastic
  Email" — it never reaches the real API. An unauthenticated POST to
  `/v4/emails/transactional` also just 400s, so the `Recipients`/`Content`/
  `Body[]` shape cannot be validated without a real key. **Acceptance = one real
  key, one real delivered send.** Per the repo's reproduce-before-fixing rule,
  everything above is code-level diagnosis; only the live send settles the body.
  *Smaller thing found alongside:* connector saves write **no `platform_events`
  row** (queried: zero connector events ever), so a failed connect leaves no
  trace to debug from. Worth stamping one.

  ### EE-1 progress — 2026-07-22, against a REAL operator key

  The operator connected Elastic Email on **Codex-test** (having disconnected
  Resend first — they found the two-step unaided, which is the UX gap in #2).
  It stored as **`status = "error"`**. Diagnosed against the live API:
  - ✅ **Defect 3 CONFIRMED and FIXED.** EE answers **HTTP 400 for everything**,
    never 401/403 — so the status-code branching could not work. The BODY is the
    signal: `"APIKey Expired"` = invalid; `"Access Denied."` = real key, wrong
    scope; 200 = valid. `verifyKey` now probes
    `/v4/statistics?from=…` (a sending key can reach it) and parses the error
    text. **Verified both ways: the operator's key → `ok, "API key valid"`; a
    garbage key → correctly rejected.** Codex-test now reads `connected`.
    *Why it failed:* the old probe used `/v4/lists`, and this key's access level
    (`SendHttp`, `ViewReports`, …) excludes contacts — a legitimately scoped key
    read as a dead one.
  - ✅ **Defect 4 FIXED.** `saveConnector` now runs `verifyKey` before storing an
    email secret, matching Clerk's existing "a connector that never worked
    shouldn't say connected" rule. Smoke tests are unaffected — they INSERT
    directly and never touch this path.
  - ✅ **Defect 2 FIXED.** `categoryConflictRefusal` → **`categoryConflict`**,
    now returning the losing provider alongside the message, and `saveConnector`
    takes `{swap:true}` — mirroring `enable_plugin`'s swap for the identical
    one-provider rule. Never implicit; the old provider is removed **only after
    the new key validates**, so a rejected swap cannot strand a project without
    email. The card surfaces a one-click "Switch to X".
    ⚠️ *Typechecked and the page compiles, but the button was NOT clicked in a
    browser — the admin console needs an operator Clerk session I don't have.
    Worth one manual pass.*
  - ⬜ **Defect 1 / the send proof — still open, and NOT a code problem.** The
    v4 wire shape remains unexercised. Blocker found: **the Elastic Email
    account has ZERO verified domains** (`/v4/domains` → `[]`), so a send from
    `test@dinodigi.com` will be refused by EE.
    🔗 **Same root cause as the Stallion "workflow" report** — that project's 8
    failed deliveries are all `Resend HTTP 403: "dinodigi.com is not verified"`.
    **Verifying `dinodigi.com` (SPF/DKIM) fixes a live client's broken
    notifications AND unblocks this proof.** It is a DNS task, not a code task.
    *When it runs:* a "sender not verified" refusal still PROVES the wire shape
    parsed; only a schema/parameter error would indict our body.

## Track 2 — Close the agent loop (the Codex findings)

- ✅ **TOK-1 — mint/rotate delivery tokens over MCP.** Two independent reports.
  ✅ **SHIPPED 2026-07-22** (operator pulled it back INTO the sprint — it is the
  biggest friction and the prerequisite for the MCP-OAuth direction, DX-6).
  What landed, matching every decision recorded below:
  - **Schema:** `project_tokens.minted_by_token_id`, self-FK **ON DELETE
    CASCADE** + index — applied to the control DB by hand
    (`scripts/migrate-token-parentage.ts`, idempotent, cascade VERIFIED via
    `pg_constraint`). Cache key bumped `token-v6` (shape gained `tokenId`).
  - **Three tools:** `mint_delivery_token` (label REQUIRED; STRICT args — a
    smuggled `scope` is refused loudly, not silently ignored; cap 25/project
    with the remedy named; parentage stamped; `shownOnce` + handling rules in
    the result), `list_delivery_tokens` (ids/labels/origin, never values),
    `revoke_delivery_token` (delivery-scope ONLY — an mcp token id is
    unfindable through it; cascade count reported; `revalidateTag` so it dies
    in seconds). `get_client_code`'s description now points at the mint tool —
    the loop closes in the agent's own reading.
  - **Attribution:** `platform_events` gained `token_mint`/`token_revoke`;
    actor = `mcp-token:<id>`; **the raw token value appears nowhere** (asserted
    by test). Console Settings → Tokens shows an **"agent" chip** on
    agent-minted rows with the cascade explained in its tooltip.
  - **Verified:** new `92-token-lifecycle.test.mjs`, 7/7 — mint works on
    delivery + is E_SCOPE on MCP; no scope parameter exists; audit row carries
    no token; list shows origin; revoke 401s the token within seconds; mcp
    tokens unrevokable by id; **CASCADE proven at the DATABASE level** (raw SQL
    delete of the minter reaps the mint — app code not involved); cap refusal
    at 25 names the remedy. Regressions: `07-tokens`/`04-delivery`/`22-authz`
    34/34 green. Success criterion 4 is MET: empty project → client → working
    delivery call, no human.
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

  ### TOK-1 — reproduced live, 2026-07-22

  The report was challenged ("is this real, or the agent hallucinating?") and
  **reproduced first-hand from an MCP session against production**, per the
  repo's reproduce-before-fixing rule:
  1. A live mcp-scoped connection exposes **58 tools; none creates, lists, or
     revokes a token.** Not read from `TOOL_DEFS` — that is the surface an agent
     actually holds.
  2. `get_client_code` on **CSLP** returned a client whose header reads
     `createClient({ token: process.env.AGENTX_DELIVERY_TOKEN! })` and whose
     request path sends `authorization: "Bearer " + options.token`. The tool an
     agent CAN call emits code needing a credential it CANNOT create.
  3. `get_project_info` → `deliveryApi.tokenScopes` literally instructs the
     agent: *"mint the right scope in Settings → Tokens."* The platform tells the
     agent to go find a human.
  4. **14 of 24 real (non-smoke) projects hold ZERO delivery tokens** — Proposals,
     Vendor Hub, Havn, Hilo, Tidewater, Andra 24, Codex, and others.

  **Framing correction:** nothing here is misbuilt. Scope separation is real
  security that already earned its keep (`tokens.ts:117` exists because of a
  field report). This is a MISSING CAPABILITY, not a defect — the MCP surface is
  complete for authoring and has no path for credential issuance. Severity
  depends on the workflow you want, not on a bug.

  ### TOK-1 — security analysis (operator discussion, 2026-07-22)

  **The marginal risk is near zero, and the reason matters.** A delivery token is
  strictly weaker than the mcp token that would authorize minting it: the mcp
  token already reads every field through `query_entries` (authoring surface, no
  `publicRead` filter), plus `export_project`, `get_audit_log`,
  `delete_collection`. An attacker holding an mcp token gains nothing by minting
  a delivery token — they would simply export the project. This is not a new door
  into the house; it is someone already inside cutting a spare key to a side door.

  **The ONE real cost is PERSISTENCE.** Today, revoking a leaked mcp token ends
  the incident. After TOK-1, an attacker who minted delivery tokens keeps a
  weaker foothold **that survives the remediation you believed was complete** —
  public reads and writes to any `publicWrite` collection, indefinitely.

  ⚑ **Therefore the load-bearing control is PARENTAGE + CASCADE REVOKE, and it is
  REQUIRED, not optional.** `project_tokens` (`db/schema.ts:212`) currently
  records no link between a token and whatever created it. Add
  `minted_by_token_id` (self-reference), and make revoking any token also revoke
  everything it minted. That restores "revoke the leaked token ends it" — the
  persistence risk disappears rather than being accepted.

  Three supporting controls: an audit row naming the minting token; an ORIGIN
  LABEL so Settings → Tokens distinguishes agent-minted from human-minted at a
  glance; and a CAP on live delivery tokens per project so a looping agent cannot
  mint ten thousand.

  **DECIDED — no opt-in toggle.** A per-project enable switch was considered and
  **dropped**. Rationale: it is *consent, not safety* — it addresses "I didn't
  know my agent could do this," which is not the security risk; the persistence
  risk is untouched by it. It also only relocates the human (one click per
  project instead of one per token) while adding a config surface, a new refusal
  path to explain, and a hand-applied column. Parentage + cascade revoke is the
  control that actually pays. **Do not let a future toggle discussion substitute
  for the cascade work.**

  **DECIDED — the agent gets `mint`, `list` AND `revoke`** (delivery-scope-only
  for each). Settled by the exposure question below: if a token reaches a public
  bundle you must kill and replace it in seconds, and a human-only revoke path
  reintroduces the exact bottleneck TOK-1 exists to remove.
  Still open: should `get_client_code`'s output point at the new tool, so the
  loop closes in the agent's own reading?

  ### TOK-1 — will a minted token leak to end users? (operator question, 07-22)

  **The platform side is CLEAN — verified 2026-07-22:**
  - `get_client_code` emits a **placeholder**, never a credential:
    `createClient({ token: process.env.AGENTX_DELIVERY_TOKEN! })`.
  - `recordAudit` (`lib/audit.ts:22`) stores `changedFields` — field NAMES, never
    values. A token cannot land there.
  - Tokens are stored hashed; the raw string exists in the mint response, once.
  - Precedent for the concern already exists: `secretShapedConfigRefusal`
    (`lib/connectors.ts:158`) blocks a secret pasted into a field that
    `list_connectors` would expose.

  **The AGENT side is the real risk, and it PRE-DATES TOK-1.** The generated
  client says "keep it server-side" — a *comment*, which enforces nothing. An
  agent can put the token in a client component or a `NEXT_PUBLIC_*` var and ship
  it to every visitor. TOK-1 does not create this; it raises how many tokens pass
  through agent hands, so it raises the frequency.

  **Blast radius is genuinely bounded** — only what is explicitly `publicRead`
  (per-field, no collection-level shortcut, `db/schema.ts:233` — default closed).
  Worked example: a published **CSLP** delivery token lets a stranger submit spam
  leads and read NOTHING (7 of 8 collections require `setUserToken()`). Caveat:
  bounded only as far as that project's `publicRead` config, and a leak allows
  wholesale enumeration rather than access through the site's UI.

  **Four requirements that follow:**
  1. **Handling instructions AT MINT TIME** — in the tool description AND the
     mint result, not only in a code comment: server-side only, never a
     `NEXT_PUBLIC_*` var, never committed. The agent reads the result; that is
     where the warning has to be.
  2. **Never write the raw token into `platform_events` or any audit note** —
     token id and label only. Nothing does this today; the NEW code is where it
     could go wrong.
  3. **Rotation is first-class** — `mint` + `list` + `revoke` (see decision
     above).
  4. *(Optional, advisory)* **Browser-use detection** — flag a delivery token
     presented with a browser `Origin`/`Referer` and surface it in Settings →
     Tokens as "appears to be used from a browser." `lastUsedAt` already exists
     (`db/schema.ts:226`), so the plumbing is half there. Will false-positive on
     legitimate browser use, so advisory only — never blocking.

  **Honest limit:** the platform CANNOT stop an agent pasting a token into
  client-side code — that is outside its boundary. What it can do is keep the
  blast radius small (already true), make the token trivially rotatable (3),
  attributable (parentage), and the instruction unmissable (1).

  **Schema cost:** `minted_by_token_id` is a hand-applied migration — `db:push`
  is broken against Neon PG18 (CLAUDE.md). **Sequencing:** MT-1 (scoped MCP
  tokens) will almost certainly touch `project_tokens` too. Doing both migrations
  in one pass beats doing them a sprint apart — a real argument for building
  TOK-1 *after* MT-1, on a token system that is already properly bounded.
- ✅ **PLUG-3 — `enabled` ≠ `applied`.** `list_plugins` gains an applied-state
  (~~`none` / `partial` / `full`~~ → **`none` / `unclear` / `full`**, see the
  block below) plus an explicit `nextAction`. Also closes a Track C
  hole: we stamp the enabled VERSION but never whether the structure landed, so
  a never-applied plugin is indistinguishable from a fully-applied one in the
  session briefing.
  ⚠️ **Must read FRESH.** `listCollections` is cached (`collections.ts:46`,
  15s TTL) and its own comment records a live incident: *"a confirmed retype
  looked unapplied because the OTHER instance kept serving the old schema."*
  ⛔ **BLOCKED 2026-07-22 — the proposed COMPUTATION is unsound, independent of
  the cache.** "Check baseline collection names against the project" was tested
  against a real applied project before coding:
  - `countryside_crm` baseline: `ranches, reps, leads, activities,
    appointments, opportunities`
  - **CSLP** actual: `accounts, activities, appointments, leads, opportunities,
    ranches, role_permissions, users`
  - Name-match = **5/6 → would report `partial`** on a fully, correctly applied
    production project. The "missing" `reps` was *reconciled into* `users`
    (role: admin|management|sales|away_team) — which is the plugin contract
    working as designed: baselines are *"adapted, not stamped"*
    (`lib/plugins.ts:20-23`, `reconcile` is a required field).
  **A rename is CORRECT behavior, so name-matching cannot distinguish
  "reconciled" from "not applied".** Shipping it would tell an agent to re-apply
  a baseline that is already live — the exact destructive-change-gate hazard the
  cache warning below is about, reached by a different route.
  **Options:** (a) GROUND TRUTH — stamp the realized collection names on
  `project_plugins` at apply time; a fact instead of a guess, but needs a
  hand-applied column plus plugin context threaded through `define_collection`.
  (b) EVIDENCE, NOT VERDICT — report `matched N of M` with the unmatched names,
  assert `none` only at 0/M and `full` only at M/M, and make the middle state say
  "may be reconciled under other names — verify before re-applying." (a) is the
  durable fix; (b) is honest and cheap.
  ✅ **DECIDED: (b), shipped 2026-07-22.** `pluginAppliedState` in
  `lib/plugins.ts` returns `{status, matched, of, unmatched, nextAction}` —
  EVIDENCE, not a verdict. Only the ends are asserted: `none` at 0/M, `full` at
  M/M; everything between is **`unclear`** (not "partial", which reads as a
  verdict) with the unmatched names handed back. The `unclear` wording names
  reconciliation as the likely explanation and says CHECK, never re-apply —
  asserted verbatim in the test, because that wording IS the safety feature.
  Attached to ENABLED plugins only; a plugin with no structure gets none. Reads
  through the new `listCollectionNamesFresh` (`lib/collections.ts`, uncached,
  names only) — the standing fresh-read rule, since a stale miss is exactly the
  false "not applied" this guards against.
  *Verified against production data:* `countryside_crm` × CSLP now returns
  `unclear 5/6, unmatched:["reps"]` + check-don't-reapply, where the original
  spec would have said "partial". All three states exercised. Smoke:
  `67-plugins` 7/7 (two assertions added to the existing enable/apply flow, plus
  a new partly-reconciled case), `78`/`82`/`87` green — 27 total; `tsc` clean.
  ⚑ **(a) is still the durable fix — backlog it:** stamp realized collection
  names onto `project_plugins` at apply time and applied-state stops being a
  guess. Best done alongside TOK-1/MT-1, which already need hand-applied
  migrations.
  Original cache warning, still valid for whichever option ships:
  Computing applied-state from that cache could tell an agent "not applied"
  about a baseline it just applied — sending it to re-apply and trip the
  destructive-change gate, which is **worse than the confusion we're fixing**.
  Same standing rule as every other correctness read.

## Track 3 — Clear the Stallion four

- ✅ **SEO title length measured on HTML-encoded text.** A 60-char title with
  two `&` reports as 68. Decode entities before measuring. (~20 min)
  ✅ **DONE 2026-07-22.** `decodeEntities` added to `lib/seo.ts` — single-pass
  (never double-decodes `&amp;lt;`), named + decimal + hex, unknown entities left
  verbatim, lone surrogates rejected. Applied at EXTRACTION, in both `attr()` and
  the `<title>` match, so lengths *and* the `found:` text we hand back are on
  rendered text. Decode-before-trim (trim strips a decoded `&nbsp;`).
  **Scope was wider than the report:** it also repairs `&amp;` inside canonical
  and og:image URLs — which is how a correctly-escaped query string legitimately
  appears in markup, so those were being reported wrong too.
  *Verified:* the report's own case now measures **59, not 67**, and draws no
  finding (score 100); canonical → `?a=1&b=2`, og:image → `?w=1200&h=630`,
  `&mdash;` counts as 1 char. **Regression test added** to
  `68-seo-plugin.test.mjs` (serves the exact markup from 127.0.0.1 — the SSRF
  guard is production-gated, so that's a legitimate dev target). Suite green
  6/6, `76-audit-site` 3/3, `tsc --noEmit` clean.
- ✅ **`delete_asset` blocked by TRASHED rows.** ⚠️ **PLAN CORRECTED after code
  audit — my original fix was wrong.** `lib/r2.ts:416-424` ALREADY runs a
  separate trashed-row check with its own message ("N trashed entries … purge
  them first"). But Stallion received the **live-ref** message ("N entries
  still reference asset … clear those fields first"), which comes from the
  `entries` query at `:405-412`. So either their blockers were genuinely live
  rows, or something leaves soft-deleted rows in `entries`. **Investigate
  which path fired before changing anything.** The part of their ask that
  survives regardless: neither message names the referencing **collection**,
  only a count — add that.
  ✅ **RESOLVED 2026-07-22 — the report's premise was wrong; the live path fired,
  correctly.** A soft-delete is a genuine MOVE, not a flag: `lib/entries.ts:1301`
  runs `DELETE FROM entries` → `INSERT INTO entries_trash` in one CTE (and
  `restoreEntry` mirrors it back). **A trashed row is physically absent from
  `entries`, so it CANNOT satisfy the live-ref query.** Stallion's blockers were
  live rows. Nothing to fix in the gate — this is the third time a field report's
  narrative has been wrong about cause, which is what the reproduce-first rule
  is for.
  ✅ **The surviving ask is shipped, and it matters more than it looked.** Both
  refusals now name the collections and the per-collection counts
  (`describeRefs` in `lib/r2.ts`) — e.g. *"blocked: 3 entries still reference
  asset X (2 in "leads", 1 in "activities") — clear those fields first"*.
  **Why it matters:** the blocking check is `data::text LIKE '%uuid%'` — a
  substring test over the WHOLE row JSON. An asset id sitting in a
  text/markdown/URL field blocks deletion exactly like a real asset field does,
  and against a bare count that is unfindable. Naming the collection is what
  makes "clear those fields first" actionable at all. (Recorded, not fixed: a
  field-aware check would be better still, but it changes gate semantics —
  backlog.)
- ✅ **Workflow actions don't fire right after a redefine.** *The headline.*
  ⚠️ **My cache-lag hypothesis is NOT supported by the code.** `update_entry`
  reads config via `mustCollection` → `getCollection`, whose TTL is
  **15 seconds** (`lib/collections.ts:46`) — that does not explain a miss
  ~60 seconds after the define. Drop the confident "fifth staleness instance"
  framing. Candidates to test, in order:
  1. `fireTransition` is **deferred** (`lib/entries.ts:262` — the earlier
     `lib/events.ts:261` citation was wrong; that line is email `replyTo`).
     Re-verified and it *strengthens* this candidate: the actions are wrapped in
     `defer(() => Promise.allSettled(...))`, so they run after the response is
     sent, with every outcome swallowed — a recycled instance drops them with no
     error surface anywhere. **Test this one first.**
  2. Next's `unstable_cache` can serve **stale-while-revalidate** past the TTL,
     so 15s is a floor, not a ceiling.
  3. The `event_action` job handler **skips silently** when the action hash no
     longer matches current config ("edited since enqueue").
  **Reproduce first.** No fix until one of these is demonstrated.
  🚧 **ATTEMPTED 2026-07-22 — NOT reproduced, and the negative result is bounded.**
  `scripts/repro-workflow-after-redefine.mjs` (new, kept) drives the exact
  reported shape against a live server: baseline transition, then redefine →
  transition at **t+0s, t+20s (past the 15s TTL), t+65s (the reported window)**.
  **All four fired.**
  ⚠️ **What that does and does not rule out.** It was run against a SINGLE-INSTANCE
  dev server, and both surviving suspicions are multi-instance phenomena that a
  single process structurally cannot exhibit: a recycled instance dropping
  deferred work, and cache divergence between instances. So this rules out a
  deterministic logic bug in redefine → transition (the config cache is NOT
  serving a workflow that lacks the action), and rules out nothing else.
  *Harness note:* the first run reported a clean pass with an EMPTY result list —
  `process.exit` inside `finally` had swallowed a thrown setup error. Fixed to
  report `HARNESS ERROR` and exit non-zero. A false green is worse than a red.
  ✅ **Shipped instead of a guess: observability, because the path was blind.**
  A delivered action already writes a `webhook_deliveries` row, so the missing
  half was the INTENT. `fireTransition` (`lib/entries.ts:262`) now logs when a
  transition MATCHES and how many actions it will dispatch, and — the real hole
  — it no longer discards `Promise.allSettled`'s results, so a rejected action
  is logged instead of vanishing. **Absence of a follow-up delivery row after a
  "transition matched" line now positively identifies dropped deferred work**,
  which is the distinction we previously could not draw at all.
  ✅ **RESOLVED 2026-07-22 by the reporter's own delivery log — no missed
  transition exists.** Read read-only from Stallion's TENANT plane (delivery
  metadata + aggregate counts only):
  - `inquiries` holds **7 `new` + 1 `contacted`** — exactly ONE entry has ever
    transitioned.
  - `entry.transitioned` delivery rows: **exactly 1, status `success`**
    (2026-07-18T14:02Z).
  **One transition occurred; one action fired; it succeeded.** There is no
  unfired action to explain. The workflow itself is wired correctly — three of
  its four transitions carry webhook actions.
  ⚠️ **Method note, worth keeping:** the first pass queried `webhook_deliveries`
  on the CONTROL DB and got "0 rows ever", which read like damning evidence. It
  was the wrong database — Stallion has its own `neon` connector, so its
  delivery rows live in its tenant plane. A control-plane query against a
  tenant-plane table returns a confident, meaningless zero.
  🔎 **What the reporter most likely saw:** the same project has **8 FAILED
  deliveries**, all `email:partners@dinodigi.com`, all
  `Resend HTTP 403: "The dinodigi.com domain is not verified"` (2026-07-15).
  Notifications visibly stopped arriving — but from an unverified sending
  domain, not from the workflow engine. Symptom real, cause misattributed;
  fourth instance of that pattern.
  *Residual:* a multi-instance dropped `defer()` remains theoretically possible
  and is now the ONLY surviving candidate — but nothing in the data evidences
  it, and the new logging would catch the next one. Closing on evidence.
- ✅ **Thumbnail burst rate-limiting.** First-request derivative generation is
  confirmed by design (`app/api/v1/assets/[id]/image/route.ts` header: resize →
  R2-cached derivative → 302). **Not** confirmed: which limiter produced their
  429s — that route shows no `rateLimit` call, so the throttle may come from
  elsewhere. Find the actual limiter before choosing between eager
  thumbnail-at-upload and `503 + Retry-After`.
  ✅ **FOUND 2026-07-22 — and neither proposed fix was the right one.** The
  limiter is in `lib/image-transform.ts`, not the route. There are **THREE**
  429 sources, not one:
  1. **Derivative budget** — 40 distinct variants per asset, no `Retry-After`
     (it is permanent until variants are reused).
  2. **Per-IP generation limit** — `img:${ip}`.
  3. **Per-asset+IP generation limit** — `img:${r2Key}:${ip}`.
  **(2) is the bug.** It passed no `max`, so it inherited the generic API brake:
  `MAX_PER_WINDOW = 20` per minute (`lib/ratelimit.ts:21`). One visitor opening
  a gallery for the FIRST time generates one transform per uncached thumbnail,
  from one IP, in one burst — so **a 21-image page 429s on first view**. That is
  legitimate traffic, and `media_gallery` is a shipped plugin whose entire
  purpose is such pages. Stallion described it exactly right; we had mis-scoped
  an abuse brake as a page-load budget.
  **Fix shipped:** `IMAGE_BURST_PER_IP = 120` for the per-IP key; the per-asset
  key keeps 20 (>20 variants of ONE asset in a minute is ladder-probing, not a
  page load). Only GENERATION is ever throttled — a cached derivative returns
  before any limiter, so steady-state views were never affected, which is why
  this looked intermittent and unreproducible after first load.
  ⚑ **Two things recorded, not changed** (both want an operator opinion):
  the per-IP key is GLOBAL across projects, so a visitor browsing two
  Pluggie-hosted sites shares one bucket; and 120/min is a judgement call —
  say the word and it moves.

## Code audit — 2026-07-22 (before writing any code)

Every claim above was checked against the source. Result: **5 verified, 1
wrong, 1 hypothesis contradicted, 1 partial.**

| Claim | Verdict |
|---|---|
| `/api/health` 503 + `healthCheckPath` points at it | ✅ `health/route.ts:28`, `render.yaml:37` |
| Degraded body has no `"ok"` (UptimeRobot keyword stays red) | ✅ body is `{status:"degraded",db:"down",latencyMs}` |
| Smoke suite runs against the PRODUCTION control DB | ✅ `helpers.mjs:11` uses `DATABASE_URL` from `.env` |
| No MCP tool can mint a delivery token | ✅✅ **reproduced live 07-22** — 58 tools in a real MCP session, none token-related; `mintToken` admin-only (`settings/actions.ts:102`) |
| `list_plugins` has no applied-state | ✅ nothing in the codebase |
| SEO title measured on encoded text | ✅ raw regex extract (`seo.ts:92`), no decode, `h.title.length` (`:196`) |
| `delete_asset` mishandles trashed rows | ❌ **wrong** — a dedicated trashed check already exists; wrong path diagnosed |
| Workflow miss = config cache lag | ⚠️ **contradicted** — 15s TTL doesn't explain a 60s-later miss |
| Thumbnail 429s come from the image route's limiter | ⚠️ **partial** — generation confirmed, limiter source not found there |
| `fireTransition` is deferred at `lib/events.ts:261` | ❌ **wrong file** — it is `lib/entries.ts:262`; the `defer()` wrap itself is confirmed |
| Elastic Email is connected but misbehaving | ❌ **wrong** — it was never connected; 0 rows platform-wide (added 07-22) |
| EE health probe's 403 = send-only-scope branch | ❌ **unreachable** — live API returns 400 for every bad-key shape |

Lesson worth keeping: the two items I stated most confidently were the two
that were wrong. Field reports describe **symptoms**; the plan may not assume
a **cause**.

## Ship ritual owed before push (CLAUDE.md)

> ⚠️ **Near-miss worth keeping (07-22):** the first full-suite run was launched
> as `npm run verify | tail -25` — the pipe reported TAIL's exit code (0) while
> the suite had failures in it, and only 25 lines of evidence survived. A
> pre-publish gate must capture the raw log and the suite's own exit code
> (`npm run verify > log 2>&1; echo $?`). The failures themselves
> (`89-schedule-mutations`, 2 assertions) re-ran 4/4 in isolation —
> load-induced timing flake from parallel test traffic on one dev server, not
> a regression; the gate re-run avoids parallel load for that reason.

Commits are being **held until the sprint is done** (operator decision 07-22),
so these run once at the end rather than per item:

- ⬜ Regenerate the AI contract — PLUG-3 changed the MCP tool surface
  (`list_plugins` output + description):
  `npx tsx --conditions react-server --env-file=.env scripts/dump-contract.ts`
- ⬜ Update `docs/CAPABILITIES.md` (plugins section — enabled vs applied) and
  bump its `Living — last synced` dateline.
- ⬜ Reconcile `docs/BACKLOG.md`: add PLUG-3 option (a) (stamp realized
  collection names at apply time) and the connector-save audit gap found under
  EE-1.
- ⬜ `npm run build` before pushing master — and **stop the :3100 dev server
  first** (shared `.next`).

## Deliberately NOT in this sprint

- **Blueprints (Plugin Phase 2)** — gated on a clean poke pass; the run is
  still in flight.
- **Feedback issues-layer, XVibe** — parked by operator decision.
- **MT-1 (scoped MCP tokens)** — the largest latent security gap (one
  all-powerful token bypasses row isolation). Too big to bolt on here;
  **nominate it to lead the next sprint.** ⚑ **Open sequencing question raised
  07-22:** TOK-1 and MT-1 both want a `project_tokens` migration, and TOK-1
  builds credential-issuance on a token that MT-1 would bound. Consider running
  MT-1 first and carrying TOK-1 with it, rather than shipping TOK-1 here.
- **A per-project opt-in toggle for agent token-minting** — considered
  2026-07-22 and dropped; see the TOK-1 security analysis for why.

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
6. Every wall item in `new` has been **reproduced and dispositioned** — fixed,
   or closed as not-a-bug with the repro attached. *(Not "empty": three of the
   Stallion four are investigate-first, and at least one may end the sprint as a
   triaged non-bug. An empty column was never the honest target.)*
7. A project can switch from Resend to Elastic Email in the console and receive
   a real email through it — the either/or design working as designed, once.
