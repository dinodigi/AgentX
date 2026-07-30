# Backlog — open ideas, feedback & parked decisions

> **Living — last synced 2026-07-29 · CP10 sweep complete: every row carries a
> disposition.** No fifth state, no "we'll see" — per
> [pm/BURNDOWN.md](pm/BURNDOWN.md).

*Single source of truth for everything raised but **not yet decided or scheduled**.
Started 2026-07-12. Sources now include the agent feedback wall
([reviews/FEEDBACK-TRIAGE-2026-07.md](reviews/FEEDBACK-TRIAGE-2026-07.md) —
source `wall`); the design thinking behind the meaty ones is captured in the
detail sections below so nothing has to be re-derived when we pick it up.*

**This doc is not the launch gate.** Launch-execution items (C1 dogfood, ops,
legal, Stripe/Clerk keys, the checklist) live in [LAUNCH-PLAN.md](plans/LAUNCH-PLAN.md).
This is the idea/feedback pipeline that feeds *future* work.

## Lifecycle

Move an item left→right as it firms up:

| Status | Meaning |
|---|---|
| ⏳ **Trigger** | Closed for now, with a **named, observable** condition that reopens it. "When someone asks again" is a trigger; "later" is not. |
| 🚫 **Declined** | We are not doing this; the reason is written in the row. |
| 📥 **Backlog** | Decided we want it (disposition: SHIP); not yet scheduled. |
| 🗓️ **Phased** | Assigned to a phase / next up. |
| 🚧 **In progress** | Being built. |
| ⚑ **Operator** | Decided; execution needs the operator (purchases, DNS, keys), not code. |
| ✅ **Shipped** | Done (commit noted — `npm run pm` verifies every cited hash exists). |

*(🅿️ Parked is retired as of CP10 — it was the "we'll see" state; every former
🅿️ row now carries a trigger or a decline.)*

Priority is **H/M/L**. Source: `audit` = readiness review, `dogfood` = real
build feedback, `design` = a design discussion here.

---

## Multi-tenancy & access
*The build confirmed this from the outside: `access.org` is enforced only on the
delivery API — MCP and admin are full-trust. This is the highest-value cluster.*

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| MT-1 | Scoped MCP tokens (per-collection / read-only / per-org) — today one all-powerful `mcp` token bypasses all row isolation. **✅ SHIPPED 2026-07-25 (`698c8d6`) as sprint item D2**: six coarse scopes (`content.read/write`, `schema.manage`, `automation.manage`, `tokens.manage`, `observability.read`) enforced at one choke point in `callTool`; legacy tokens grandfather as full access (`scopes = null`); a completeness test fails if any tool lacks an assignment. *Per-collection and per-org scoping remain unbuilt — reopen as MT-1b if a project needs them.* | ✅ Shipped | H | audit #1, dogfood |
| MT-2 | Org-scope the admin view — an invited client-role member sees every org's rows in the admin, so `access.org` isolation holds on delivery but not in the console. *(CP10 note: the "hand the admin URL to the client" `get_project_info` copy is no longer present — the live blob lists `urls.admin` without advice to share it — so the remaining item is the org-scoped VIEW, which is real feature work.)* | 📥 Backlog | H | audit #2 |
| MT-3 | Per-org composite unique (`unique:[orgField, field]`); stop the violation error leaking that a hidden row exists. **⏳ TRIGGER: a project with `access.org` requests org-scoped uniqueness, or the cross-org unique-violation leak is reported on the wall.** No org-scoped project has needed it yet; plain `unique` + the org field in a computed template key is the interim (the membership_key pattern). | ⏳ Trigger | M | audit #3 |
| MT-4 | Require `confirm:true` when a redefine **drops an existing `access` block** — small and precedented (the workflow-drop confirm gate `6256c51` is the exact template; SEC-1's publicRead gate is another). The project-level "require access rules on every collection" setting half: **⏳ TRIGGER — a second tenant asks for a policy floor.** Batch the confirm-gate half with the next schema-gate change. | 📥 Backlog | M | audit #4 |
| MT-5 | Claim-based workflow transition actors. *(The acute half ✅ shipped `2798606` — the operator/client actor split, closing the "admin includes your own clients" trap two testers hit.)* **⏳ TRIGGER: a workflow needs an actor finer than operator/client/delivery — a wall report or a define attempt the current vocabulary cannot express.** | ⏳ Trigger | M | audit #5, wall |
| MT-6 | A way to **test** isolation from the build loop (mint/supply an end-user JWT, or an isolation harness) — today you can't verify it from MCP. **⏳ TRIGGER: ENV-1 staging exists (the safe place to mint test identities), or a second integrator reports shipping without being able to verify isolation.** | ⏳ Trigger | M | dogfood |

## Write-path & delivery ergonomics

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| WP-7 | **Bulk write + delete on the delivery API.** Bulk ops are MCP-only, so a delivery-side client deleting/creating N loops N calls → 429. *(Batch **reads** ✅ shipped `POST /api/v1/batch` 2026-07-17; writes/deletes still loop. MCP `bulk_create_entries` cap since raised 100→500 `f5a99f7`. The QRY-3 half — publishing the limits so clients can pace — ✅ closed in CP10, so this item is now only the endpoint.)* (See detail.) | 📥 Backlog | H | dogfood, wall |
| WP-8 | Delivery-**read** rate limiting. **⏳ TRIGGER: an abuse incident or cost spike attributable to public reads (CDN-miss traffic — visible in Neon CU / Render metrics).** Reads ride the CDN, which is the shield; a budget would mostly tax cache misses, and every abuse-shaped surface (writes, search, transforms, checkout, batch) is already limited. | ⏳ Trigger | L | audit |
| WP-3 | Fix the hooks×bulk **contract contradiction** — **✅ ANSWERED 2026-07-29 (CP10)**: the `define_collection.hooks` description said bulk was "refused"; the code has run the hook PER ITEM (bounded concurrency, budget-derived cap) since I5. The description now states the per-item truth, and a contract test asserts the words match the behavior so the lie cannot regrow. | ✅ Shipped | — | audit #8 |
| WP-1 | `Idempotency-Key` on delivery `POST`. **⏳ TRIGGER: a duplicated delivery-side submission is reported on the wall, or WP-7 ships (a bulk endpoint should carry idempotency, so build them together).** MCP `create`/`transact` keys are the server-side interim. | ⏳ Trigger | M | audit #6 |
| WP-2 | `If-Match` (compare-and-set) on delivery `PATCH`. **⏳ TRIGGER: a delivery-side lost-update is reported.** MCP `update_entry_if` is the documented server-side answer; ETags are already served so the reader half exists when this fires. | ⏳ Trigger | M | audit #7 |
| WP-6 | Event webhooks: **fail closed** when no signing secret (verified still true in CP10 — `deliverWebhook` sends unsigned when `project.secret` is absent, while before-write hooks refuse at define time). Fix shape: the same define-time gate hooks use — refuse to DECLARE an event action while the project has no signing secret — which breaks nobody live until their next redefine; plus document event-webhook signing (CONTRACT-1 carries the doc half). | 📥 Backlog | M | audit #11 + code |
| WP-4 | Document same-state workflow write semantics — **✅ ANSWERED 2026-07-29 (CP10)**: the workflow description now states that writing the CURRENT state back is an idempotent no-op on `update_entry` (never treated as a transition — a full-replace patch echoing the field must not trip the actor gate) while `update_entry_if` diagnoses its no-ops as E_CONFLICT. Contract test asserts it. | ✅ Shipped | — | audit #9 |
| WP-5 | `after` (deferred) actions on workflow transitions. **⏳ TRIGGER: a second request.** The define-time refusal already names the workaround verbatim ("use an entry event action for delayed sends"), so nobody is stuck — they are redirected. | ⏳ Trigger | L | audit #10 |

## Secrets

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| SEC-1 | **Masked / write-only field type** — **✅ SHIPPED 2026-07-29 (`4de9ddb`)** as sprint item D1: `{type:"text", writeOnly:true}` is written but never returned by any read. The invariant is that the field's NAME never appears as a key in any read payload — not masked, absent — enforced in two layers: storage minimisation (versions, change feed and event payloads strip before the write) plus read redaction at every boundary, which is load-bearing rather than belt-and-braces because a field FLIPPED to write-only leaves plaintext in history the first layer cannot reach backwards into. Filtering/sorting/selecting it is refused (a filter is a read with extra steps), as are the combos that would serve the value or make it an existence oracle (publicRead/unique/capacity/indexed/searchable/localized/computed), nesting it in a group/array, deriving a computed field from it, and using it as a relation labelField or an email token. *Platform-side credential VERIFICATION (`verify_credential`) is deliberately NOT part of this — see the SEC-3 entry below.* | ✅ Shipped | — | audit #12, wall `0ceec805` |
| SEC-3 | **Platform-side credential verification** (`set_credential` / `verify_credential`) — the half of wall item `0ceec805` that SEC-1 does not close. A salted hash must be COMPARED to be verified, and a comparison is a read, so a write-only field cannot hold one: argon2id embeds a random salt, so you cannot even recompute the hash without the stored value. Verification therefore still lives on each tenant's own auth service, and `auth_kit` v2 ships the recipe (argon2id parameters, the real-dummy-hash timing defence, atomic lockout, single-use non-enumerating resets) instead of the mechanism. Taking this on means owning password reset, MFA and session revocation permanently — the identity-provider scope DECISIONS-CP9 declined. **⏳ TRIGGER: a second project independently asks for platform-side verification, or a tenant ships a demonstrably wrong implementation of the recipe.** | ⏳ Trigger | M | wall `0ceec805` |
| SEC-2 | Reject secret-shaped values (`sk_`/`rk_`/`whsec_`) in non-secret connector config fields + Clerk `pk_` shape check | ✅ Shipped `e59d13e` | — | dogfood |

## Query & scale

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| QRY-3 | **Publish the limits in the contract** — **✅ ANSWERED 2026-07-29 (CP10)**: the delivery contract now states the actual numbers — 20 mutations/searches/uploads/checkouts/batches per rolling minute per IP per project (fixed windows, `429` + `Retry-After` + `E_RATE_LIMITED`), the 1 MiB delivery JSON body cap (`413`), the 10 MB upload cap — alongside the MCP 300 calls/min/project that `statelessTransport` already carried. A contract test asserts the numbers stay published. Clients can finally pace instead of discovering the wall. | ✅ Shipped | — | audit #16, dogfood, wall |
| QRY-1 | Range/absence operators + keyset cursors on the **delivery** read surface (today: equality + `has` + offset only). *(The MCP half is complete — `ne`/`neOrUnset`/`exists`/`gt`/`lt` + cursors all exist, `neOrUnset` shipped `0dbf3ff`.)* **⏳ TRIGGER: a delivery-side client blocked by equality-only filtering, naming the query it cannot express (wall).** The documented interim is a stateless MCP call server-side — which is exactly what Hatchly and Fatsoz built. | ⏳ Trigger | M | audit #14, wall |
| QRY-2 | Async full export (dump to R2) for very large sets. *(The 5,000-row cap itself ✅ resolved `748d7f9` — `export_entries` pages a keyset cursor to a complete export; this item is now only about one-shot R2 dumps.)* **⏳ TRIGGER: a real export that needs ~20+ pages (≈100k rows) shows up in the field.** | ⏳ Trigger | L | audit #15 |
| QRY-5 | **Reporting: date-bucketed aggregates + a second `groupBy` dimension** — **✅ SHIPPED 2026-07-29 (`0ee45c9`)**: `groupBy` takes `{field,bucket:day\|week\|month\|quarter\|year}` or an array of up to two dimensions. A date with NO bucket is refused (it would make one group per row, then truncate into a report that looks complete), and `key` still carries the first dimension so no existing caller changed shape. | ✅ Shipped | — | wall |
| QRY-4 | **Entry-level import/seeding** (`import_project` is schema-only). **Raised to H in CP10: this is the named blocker on the operator's dev/prod split** (make `pluggie.app` the dev environment, deploy clean on `plugster.dev` — HANDOFF-D1 records it as "undecided pending entry counts" precisely because content cannot be moved). Fix shape: an entry-data half for the manifest, or a paged import that pairs with `export_entries`' keyset cursor — the export half already exists and is exact. *(The staging-environment half of the old item is ENV-1.)* | 📥 Backlog | **H** | audit #17, operator |

## Data model

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| DM-1 | **Nested `list`/`object`/repeater field type** | ✅ Shipped 2026-07-15/17 | — | design, dogfood |
| | *Shipped as structured fields (`group`/`array`, one-level, recursive validation/projection, repeater editor) + heterogeneous **block types** with a `define_block` library. Remaining tail (relations-in-blocks polish, block library v1.1) tracks in plans/POST-DEPLOYMENT-V2-PLAN.md.* | | | |
| DM-2 | **Enum option renames with mapped backfill** — **✅ SHIPPED 2026-07-29 (`260e64b`)**: `renames` now also takes `{field,from,to}`, rewriting the VALUE in place across live rows AND trash (a restore would otherwise resurrect a value the schema rejects). Strictly validated, since a typo here rewrites stored data. | ✅ Shipped | — | wall |
| DM-3 | Counting/capacity constraint — **✅ SHIPPED 2026-07-29 (`bea3377`)** as `capacity: N` on a field. Enforced by a tenant-DB trigger taking a per-key advisory lock, because a count-then-insert cannot be made correct from outside the database; a test rushes a 3-seat slot with 10 concurrent bookings and demands exactly 3 winners. | ✅ Shipped | — | wall |
| DM-4 | **`indexed` on date fields** — **✅ SHIPPED 2026-07-29 (`2dfa814`)**. No shadow column needed: Postgres refuses `::timestamp` as well as `::timestamptz`, but the raw TEXT index it does allow is EXACT here, because writes store fixed-width canonical UTC ISO and that sorts lexicographically exactly as it sorts chronologically. An EXPLAIN test asserts the planner really uses it (index scan, range as Index Cond, no separate sort); existing values are canonicalized when the index is added. | ✅ Shipped | — | wall (Fatsoz) |

## DX & docs

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| OPS-5 | **Base-domain move** (e.g. `plugster.co`/`.io`) — `pluggie.io`/`.net` are held by a UK company. **Measured 2026-07-28, the code is nearly uncoupled:** only 4 literal `pluggie.app` strings exist (an `APP_URL` fallback, two SEO user-agents, one `render.yaml` value); everything else reads `APP_URL` (11 uses / 6 files). 0 stored webhook URLs carry the domain; tokens are opaque; assets (`pub-*.r2.dev`) and email (`dinodigi.com`) are unaffected. **The cost is external, not internal:** OAuth is the sharp edge — RFC 8707 resource indicators and RFC 8414 metadata are domain-bound, so every connected MCP client re-authorizes and the 2 registered clients re-register; plus Cloudflare zone, Clerk origins, UptimeRobot ×3, and re-pointing each deployed client app's `baseUrl`. **Do it ADDITIVELY** — add the new primary and keep `pluggie.app` serving as an alias forever — which turns a breaking cutover into a config change. A brand *rename* (17 files carrying "Pluggie" copy + docs + the MCP server identity string shown in client UIs) is a separable, larger job.<br><br>**Operator direction 2026-07-29 — TWO PRODUCTS, deliberately unmixed.** Plugster is the API/backend; XVibe (`xvibe.app`, owned) is where you build and deploy. **DECIDED 2026-07-29 — domain map:** `plugster.dev` platform · `api.plugster.dev` delivery+MCP · `xvibe.app` XVibe studio (owned) · `*.myxvibe.com` deployed tenant apps.<br><br>Why `.dev` over `.co`: exact brand match (`.io` taken, `.com` for sale at **$10K** — declined pre-revenue; a parked .com is harmless, no competitor or mark, and the typo leak is identical under any TLD since people type .com regardless — revisit when $10-15K is unremarkable, with the listing going inactive as early warning). `.dev` also signals correctly to the developer/agency audience and pairs with `xvibe.app` as one family. **Operational: `.dev` and `.app` are both HSTS-preloaded TLD-wide, so the entire production family is HTTPS-only with no HTTP fallback — including anything local pointed at those hostnames.**<br><br>**MIGRATION MECHANICS (checked 2026-07-29).** (1) The generated client is ALREADY host-configurable — `createClient({baseUrl})` overrides the baked `DEFAULT_BASE_URL`, so a switch is one line per app, or zero if the app reads an env var. Worth adding before the switch: have the generated client prefer an env var over the baked default, so a redeploy moves hosts with no code edit. (2) For the old host, do NOT redirect — a 301 breaks POST bodies in several HTTP clients and mangles auth headers across origins. Serve **RFC 8594 deprecation headers** while continuing to answer normally: `Deprecation: true`, `Sunset: <date>`, `Link: <new>; rel="successor-version"`, plus the same note in `get_project_info` so AGENTS read it, not just humans. (3) The part that makes it a tool rather than a header is **instrumentation** — log project+token+timestamp for every call still hitting the old host, so "is it safe to switch off?" is a query, not a guess. (4) **We do not actually have to retire `pluggie.app`.** Keeping it alive is one DNS record and one cert, and it is what makes the OAuth cost vanish entirely — connected MCP clients never re-authorize. Deprecation headers move everyone; permanence means nothing breaks if someone misses the memo.<br><br>**`onplugster.com` is NOT needed — earlier advice withdrawn.** The case for a second registrable domain was tenant-served HTML (one tenant's XSS reaching the control plane via cookies on a shared parent — the reason `github.io`/`vercel.app`/`myshopify.com` exist). With Plugster as a pure API that never emits tenant HTML (bearer-token JSON, no cookies; assets already isolated on `pub-*.r2.dev`), that risk lives entirely in XVibe. `api.plugster.co` suffices; a second origin with no job is just another cert, zone and monitor. **The isolation boundary — and the Public Suffix List submission — belongs on `myxvibe.com`**, following Shopify's `*.myshopify.com` precedent exactly.<br><br>Two consequences: `.app` is HSTS-preloaded TLD-wide, so `xvibe.app` has no HTTP fallback ever (bites local dev once). And this makes **D3 (browser-safe delivery credential) more urgent** — every tenant site becomes a distinct origin calling `api.plugster.co` cross-origin, so the per-app edge proxy XVibe runs solely to hold a token stops being one team's quirk and becomes the default shape of every deployed site. (2) **`plugster.com` checked 2026-07-29: FOR SALE (parked), not an active business** — so the trademark risk really is much lower than pluggie.io/.net, because marks come from use in commerce and a parking page is not use. Two follow-ups while it is cheap: the asking price **rises with our traffic** (a parked domain's owner watches type-ins, so the cheapest moment to buy is before launch, not after — get the number now even if we decline), and **a domain search is not a trademark search** — the actual risk check is UKIPO + USPTO for "plugster" in Nice classes 9/42, which is free and is the question we were really asking. If `onplugster.com` will serve tenant sites, submit it to the **Public Suffix List** immediately on purchase — free, but weeks to propagate, and it is what keeps cookies from leaking between tenant sites. **CP10 disposition: ⚑ Operator — everything decidable is decided (domain map 2026-07-29), the code-side prep is measured and small, and what remains is purchases + DNS + PSL, none of it mine. Reopens the moment `plugster.dev` exists.** | ⚑ Operator | M | operator, trademark risk |
| DX-2 | Serve the contract + hook docs over HTTP (`/api/contract`, a public `hooks.md`) — today the contract references repo files an API consumer can't reach. Starter exists: `scripts/dump-contract.ts` → `docs/ai-contract.md`. **CP10: folded under CONTRACT-1 as its "self-contained" principle made concrete — build them in one pass.** | 📥 Backlog | M | audit #19 |
| DX-5 | **Document stateless MCP-over-HTTP as a supported server-side pattern** — **✅ SHIPPED 2026-07-26 (`66ad28e`, friction sprint)**: `get_project_info.deliveryApi.statelessTransport` now teaches the bare JSON-RPC POST (no handshake, no session id, no SDK), names the serverless use case, the result shape, and the 300/min budget. *(Found stale in the CP10 sweep — the third time a shipped item read "not started" here; the `npm run pm` hash-verification pass added in CP10 exists because of rows like this one.)* | ✅ Shipped | — | wall ×2 |
| TOK-1 | **Mint/rotate delivery tokens over MCP** — `mint_delivery_token` / `list_delivery_tokens` / `revoke_delivery_token`, delivery-scope hard-fixed, parentage + DB-level cascade revoke (`minted_by_token_id`), cap 25/project, platform-events trail, console "agent" chip. Success criterion "empty project → working delivery calls without leaving MCP" met. Unblocks DX-6 (MCP OAuth). | ✅ Shipped `698c8d6` | **H** | wall ×2 |
| TOK-2 | **Sub-issue kept from TOK-1:** a mint that would exceed the cap answers `E_CAP_REACHED` with the remedy — surface token-cap headroom in `get_project_info.briefing.health` so agents see it BEFORE minting. **⏳ TRIGGER: an agent actually hits the 25-token cap in the field (`E_CAP_REACHED` on mint in platform_events).** The error already carries the remedy. | ⏳ Trigger | L | design |
| PLUG-3 | **`enabled` ≠ `applied`** — shipped as EVIDENCE-not-verdict: `applied` `{status: none\|unclear\|full, matched, of, unmatched, nextAction}`, fresh-read, ends-only assertions ("partial" was provably wrong on CSLP — reconciled renames are CORRECT behavior). | ✅ Shipped `371fe29` | M | wall (Codex) |
| PLUG-4 | **Kept from PLUG-3:** the durable fix — stamp REALIZED collection names on `project_plugins` at apply time, turning applied-state from a name-match guess into a fact (also kills the renamed-everything false-`none`). Wants a hand-applied migration; **batch with the next hand-applied schema change — do not run a migration for this alone.** | 📥 Backlog | M | design |
| OPS-3 | **Health check: split liveness from readiness** — shipped: 200 + degraded body, keyword-monitor requirement documented, degraded path verified by simulation (`scripts/verify-health-degraded.mjs`). ~~Cost claim~~ retracted in the sprint plan (the every-minute drain cron keeps the DB awake regardless). | ✅ Shipped `371fe29` | **H** | incident |
| OPS-4 | **Dedicated test database** — the smoke suite runs against the production control DB (~300 tests/run; the 2026-07-21 outage's trigger, now a cost/hygiene issue after the Neon upgrade + OPS-3). Scope grew in the sprint audit: `.env.test` must cover the app process AND every test file (ten open their own `neon()` client), plus a hand-applied schema copy (db:push broken). **Also phase one of ENV-1 (staging).** Waiting on: operator creates a Neon project and drops the string in `.env.test`. **✅ SHIPPED 2026-07-25 (`5768c5e`)**: `npm run smoke` now defaults to a dedicated Neon project (`pluggie-test`, PG18.4); the dev server and smoke runner share one `.env.test`; proven by unchanged production row counts across a full 633-test suite. | ✅ Shipped | **H** | incident |
| OPS-2 | **Breaking-change comms.** *(Re-scoped in CP10: the AGENT half shipped in the friction sprint — `briefing.notices` announces platform changes since a project's last session, shown once.)* What remains is the HUMAN channel: changelog + advance notice for operators who are not in an agent session — which is exactly NOTIF-1's bell + OPS-1's mailer. Build as NOTIF-1's first use case, not separately. | 📥 Backlog | H | wall (Stallion) |
| DX-6 | **MCP OAuth — connect with a URL, nothing else** (operator, 2026-07-22; "the one I like most"). The MCP spec supports authorization for remote servers: a client is given `https://pluggie.app/api/mcp`, completes auth in a browser, and is connected — no token pasting, no config file, no CLI. Today the ONLY way to get a token is a human clicking in the console, which is why setting up MCP feels fuzzy on every new project. **Depends on TOK-1 (programmatic issuance) on top of MT-1 (bounded tokens)** — MT-1 → TOK-1 → DX-6 is one capability in three layers, not three items. Interim fallback if OAuth proves slow: a `npx pluggie init` CLI that authenticates, mints, and writes `.mcp.json` (~1 day, same dependency). **✅ SHIPPED + LIVE 2026-07-26 (`f925dc2`) as sprint item D3**: RFC 8414 metadata + RFC 7591 dynamic registration + RFC 9728 protected-resource discovery + mandatory PKCE + RFC 8707 audience binding, with a consent screen that names the project. Verified end-to-end against a real Claude Code client on production. *Refresh-token rotation deliberately deferred — tracked as OAUTH-R.* | ✅ Shipped | **H** | operator |
| ENV-1 | **Staging environment — an online copy of the platform to debug against** (operator, 2026-07-22; parked deliberately to finish the current sprint first). **Why it's sharp:** there is currently NO separation at all — local dev and pluggie.app share one control DB *and* one `CONNECTOR_MASTER_KEY` (verified 07-22 by decrypting a prod-written secret with the local key). Connecting a connector "locally" switches a REAL project; 185 orphaned test projects accumulated in the production control DB. There is nowhere to make a mistake safely. **Needs:** a second Render service off a `staging` branch (`render.yaml` makes this mostly config) · its own Neon control DB · its own R2 bucket/prefix · a separate Clerk instance · **its own master key — sharing one is relabeling, not isolating** · `staging.pluggie.app`. **Plus tooling:** realistic seed data, a reset command, and a schema-sync path given `db:push` is broken vs Neon PG18. **OPS-4 is phase one of this** — a separate control DB + `.env.test` is the first and hardest brick; build it for tests and staging extends it rather than starting over. Next-sprint sized; pairs naturally with MT-1, since staging is what makes token/OAuth work safe to iterate on. | 📥 Backlog | **H** | operator |
| DX-1 | Add search + idempotency to the generated TS client (uploads/checkout/changes already covered). **CP10: folded under CONTRACT-1** — the generated client is one of its named surfaces; one pass, not two. | 📥 Backlog | M | audit #18 |
| DX-3 | Public compliance page (encryption-at-rest / residency / SOC2 / GDPR posture); optional authenticated image-variant URLs. **⏳ TRIGGER: the first procurement / security questionnaire arrives from a prospect.** Writing it before anyone asks would be guessing at which claims matter. | ⏳ Trigger | M | audit #20 |
| DX-4 | Timezone-aware schedules with DST (today UTC-only). **⏳ TRIGGER: a tenant asks for local-time schedules or reports a DST mis-fire.** | ⏳ Trigger | L | audit #21 |

## Agent contract & language ★
*The tool descriptions + `get_project_info` **are** the product for the AI
audience — agents plan against them and trust them over the code. A large share
of this cycle's "gaps" were contract failures, not capability gaps: the reviewer
audited from the contract and got things wrong; the dogfood agent missed a
**documented** upload endpoint and invented a keys-in-the-web-app hack. This is
the umbrella initiative to fix that surface end to end.*

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| CONTRACT-1 | **Full pass over agent-facing language** — every tool description, `get_project_info`, `list_field_types`, error copy, and the generated client. Accurate, complete, discoverable, self-correcting, self-contained. Umbrella over WP-6-docs, DX-1, DX-2. *(CP10 knocked three defects off its checklist: WP-3 contradiction fixed, WP-4 semantics stated, QRY-3 budgets published — each pinned by a contract test, which is the anti-regression method the detail section prescribes.)* **This is the next flagship initiative now the wall is clear.** (See detail.) | 📥 Backlog | H | design, dogfood, audit |

## Billing
*Two Stripe surfaces — don't conflate them. **Platform billing** (Pluggie
charging tenants $19/$29 per project) already does subscriptions. **Tenant
checkout** (a tenant's storefront selling to their own customers) is
payment-mode only — that's BILL-1.*

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| BILL-1 | **Tenant subscription commerce** — tenant checkout is hardcoded `mode:"payment"`; recurring is a cluster (mode + lifecycle webhooks + portal + gated collections), not a flag. **⏳ TRIGGER: a tenant attempts recurring commerce — observable as a checkout attempt against a recurring `price_` (Stripe rejects it; `E_UPSTREAM` lands in get_deliveries) or a wall request.** The lifecycle design is captured in the detail section so nothing is re-derived when it fires. | ⏳ Trigger | M | audit #13, dogfood |

## Product ideas (features, not fixes)

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| NOTIF-1 | In-app **notification center** for the PLUGGIE ADMIN (shape decided — see detail). **Now carries OPS-2 (breaking-change comms) as its first concrete use case, which upgrades it from nice-to-have to the fix for a production incident** (a behavior change took a live site down with zero notice). Ready to spec/build. *(Tenant-side story ✅ shipped as `notification_kit` 2026-07-19.)* | 📥 Backlog | M | design, wall (Stallion) |
| NOTIF-2 | Notification channels: Slack/Discord, then email. **⏳ TRIGGER: NOTIF-1 exists and a tenant asks for a channel beyond the bell.** | ⏳ Trigger | L | design |
| OPS-1 | **Platform mailer** — shared dependency for NOTIF email + C5 ops alerting. **Batch with NOTIF-1's email phase; do not build standalone** (a mailer with no sender is scaffolding). | 📥 Backlog | M | design |
| PLUG-1 | **AI-registered tools** (self-extending agent, V1) + endpoint governance. **⏳ TRIGGER: post-launch AND a concrete tenant use case for an agent-registered verb arrives.** The exfiltration-governance design constraint is recorded in the detail section and is load-bearing — build it in from day one when this fires. | ⏳ Trigger | L | design |
| PLUG-2 | **Base/blueprint composition model** — **Phase 1 ✅ SHIPPED 2026-07-25** (`036ace2` composition core provides/requires/one-provider · `9bc9988` AUTO-1 scheduled mutations · `5001bb0` applied-version tracking + session briefing · `725ef29` wave-1 bases: booking, waitlist, feedback_wall, media_gallery — suites 87-90 green). **Phase 2 (blueprints) ⏳ TRIGGER (as the plan already decided) — TRIGGER: the operator's poke project passes clean on bases alone AND the operator calls for blueprints.** Plan: [plans/PLUGIN-BASES-PLAN.md](plans/PLUGIN-BASES-PLAN.md). *(Row read "🚧 In progress" while all four Phase-1 tracks were shipped — the fourth stale-in-the-flattering-direction row this doc has held.)* | ⏳ Trigger | H | design, wall |
| PANEL-1 | **In-chat panels via MCP Apps** — interactive panels in the builder's chat (test console from plugin `acceptance` arrays, onboarding wizard, briefing dashboard). **⏳ TRIGGER: PLUG-2 Phase 2 begins, or MCP Apps rendering lands in a host our integrators actually use.** Host-support gated by nature. | ⏳ Trigger | M | design |
| BRAND-1 | Appearance **brand-kit → agent design tokens** + live preview. **⏳ TRIGGER: the operator green-lights design-token work, or a client asks for brand-driven builds.** | ⏳ Trigger | L | design |
| CONN-1 | **Provider registry / swappable integrations** | ✅ Shipped 2026-07-21 | — | design |
| | *Category↔provider split (`PROVIDER_CATEGORY`), adapter interface per category (`lib/providers/email.ts`), Elastic Email as the proving 2nd provider, one-active-per-category enforced at connect time (no schema change — categories are derived), fresh-on-miss resolution. Storage/database deliberately excluded (stateful). Next provider = adapter + map entry.* | | | |
| CONN-2 | **SMS connector** (Twilio-shaped) — `{type:'sms', to:'{{phone}}'}` event actions gated on consent flags. *(Unblocked mechanically: CONN-1's registry shipped — a new `sms` category + adapter, following the email pattern.)* **⏳ TRIGGER: a tenant with consent data (countryside ships `text_opt_in`) asks to actually SEND — today the field exists with nothing to act on, and nobody has asked to act.** | ⏳ Trigger | M | wall |
| AUTO-1 | **Declarative scheduled data mutations** — **✅ SHIPPED 2026-07-25 (`9bc9988`)** as Plugin Bases Plan Track B: `define_schedule` takes a `mutate` action (cron + `where` + `set`/`transition` + `guard`), rows selected then written through CAS so a concurrently-changed row is SKIPPED, never stomped; transitions ride workflow validation as the mcp actor; audit rows carry the schedule's name; bounded per tick. The CRM recycle sweep self-hosts. *(Another row found stale in CP10.)* | ✅ Shipped | — | wall |
| EMAIL-1 | **Email template management layer** — the styled HTML engine shipped (`8cbdf30`); the builder/library/admin form did not. **⏳ TRIGGER: an operator or client asks to edit templates in the console.** The engine covers every send shipped so far; a management UI with no manager is furniture. | ⏳ Trigger | M | design |
| FEED-1 | **Feedback issues layer** (canonical issues + auto-attach dedup + smart `send_feedback` replies + ranked board) — designed, board mockup agreed. **⏳ TRIGGER (decided 2026-07-19, kept verbatim) — TRIGGER: the same item arrives from 3+ projects, or manual triage becomes ritual.** The burn-down just proved manual triage works at 32-item scale; the trigger stands. | ⏳ Trigger | M | design |
| FEED-2 | **Client-facing feedback plugin** | ✅ Shipped 2026-07-21 | — | design |
| | *Shipped as the `feedback_wall` wave-1 base (Plugin Bases Plan Track D): public intake, our own triage pipeline, server-owned statuses, report recipes.* | | | |

---

# Detail — the meaty ones

## CONTRACT-1 · Agent-facing language pass ★ (design + dogfood + audit)

**Why this is a flagship, not a docs chore.** For the AI-integrator audience the
tool descriptions + `get_project_info` are the *entire* product surface — an
agent plans and builds against them, and **believes them over the code**. Across
this cycle almost every "gap" was really the contract hiding, contradicting, or
under-selling something the code already does:
- the reviewer audited from tool descriptions and reached several wrong
  conclusions (offset-only, no cursors, no backup, "CRUD-only client") — all
  *documentation* misses, not capability misses;
- the dogfood agent missed the **documented** `POST /v1/{collection}/uploads`
  endpoint and reached for a keys-in-the-web-app anti-pattern;
- a live contradiction (WP-3) would make an agent code to the wrong branch.

So this surface directly drives credibility with the exact audience the platform
is built for.

**Scope (the surfaces to audit):**
- `TOOL_DEFS` — all 42 tool descriptions + input schemas (`lib/mcp/tools.ts`).
- `get_project_info` — the orientation blob (URLs, boundaries, `deliveryApi.*`, `compute.*`).
- `list_field_types` + `COMMON_FIELD_CONFIG`.
- Error messages + codes — are they self-correcting (name the fix)?
- The generated TS client (`get_client_code`).
- Referenced docs (`hooks.md` …) — reachability (→ DX-2).

**The bar (principles):**
1. **Accurate** — never contradict behavior (WP-3 is a live violation).
2. **Complete** — every capability is discoverable (cursors #14, retention #15, limits/429/retry-after QRY-3, event-webhook signing WP-6).
3. **Discoverable** — the agent shouldn't need to already know an endpoint exists to find it. The "how do I upload / paginate / handle 429 / verify a webhook / sell a subscription" questions must be answered where an agent looks.
4. **Self-correcting** — every error names the fix (the codebase does this well in places; make it universal).
5. **Boundary-honest** — keep stating what the system does NOT do, so the agent never hunts for a missing tool.
6. **Self-contained** — no references to repo files an API consumer can't fetch.

**Concrete defect checklist (known instances — fold these in):**
- WP-3 — hooks×bulk contradiction (a lie in the contract).
- WP-6 — event-webhook signing absent from tool descriptions.
- QRY-3 — rate budget / 429 / retry-after / size caps unpublished.
- #14 keyset cursors (exist on MCP) not surfaced; #15 30-day retention buried.
- WP-4 — same-state workflow write semantics unstated.
- **Uploads discoverability** (this thread): add a line to `get_project_info`'s boundaries — *"web/site uploads use `POST /v1/{collection}/uploads` with the delivery token → an asset field; never embed R2 or MCP credentials in a client."*
- Whatever else a systematic **behavior-vs-description diff** turns up.

**Method + anti-regression:**
- Systematic pass: for each tool and each `deliveryApi` capability, diff *what the code does* against *what the contract says*; fix contradictions, add missing capabilities, sharpen discoverability + error copy.
- `scripts/dump-contract.ts` already emits the full contract — use it as the review artifact each release, and diff it when `tools.ts` changes so drift is caught.

**Sizing:** many small edits + one structural rethink of `get_project_info` (organize it around the questions agents actually ask). High value, moderate effort, low risk.

## WP-7 · Bulk write + delete on the delivery API (dogfood)

**What happened:** a client's `deleteLeads` fired ~50 raw `DELETE /v1/{collection}/{id}` calls in a tight loop and hit **429**. There is **no bulk-delete anywhere** (delivery *or* MCP), and **no bulk write on delivery at all** — `bulk_create_entries` is MCP-only. So any delivery-side batch (delete N, or the 500-create batch builder) must loop, and the durable rate limiter (20/60s/IP) stops it.

**The two real gaps:**
1. **No batch endpoint on the delivery surface.** Options: a `POST /v1/{collection}/bulk` (create/delete many, capped), or documented client-side batching guidance.
2. **Undocumented rate-limit semantics** (→ QRY-3). The 429 *does* carry `retry-after` and `E_RATE_LIMITED`, but it's not in the contract, so clients don't build rate-limit-aware retry/pacing by default.

**Fix shape:** ship a capped bulk delete/create on delivery **and** publish the limits + retry-after so a generated client can pace itself. Do them together — a bulk endpoint without documented limits just moves the wall.

## DM-1 · Nested / repeater field type (design)

**Gap:** the model is flat — a record is a bag of single scalars + one-to-one relations. No arrays, no nested objects. "Many owned sub-records" (hours, FAQ, tiers, bullets) forces either a rigid flatten, unstructured richtext, or a whole child collection + join.

**Recommended shape:** one `list` type whose `of` is a scalar **or** a fixed object (covers bullet lists *and* repeaters like business hours); optional standalone `object` for fixed groups (SEO, address). Constraints that preserve the flat engine: **one level deep, opaque leaf** (no filter/sort/`unique`/`computed` on nested — same rule `localized`/`richtext` already follow), `publicRead` all-or-nothing, bounded item count.

**Performance note (important):** embedded = **the fast path** — JSONB in the same row, one read, no join. It's *faster* than the child-collection alternative (which joins). It gives up native queryability on the nested data, not speed — and you can buy that back on demand with a **GIN index** or a **shadow projection** without adding a join. Same expression-index machinery the platform already uses for `unique`.

**Cost split (why it's a real feature, not a knob):** ~⅓ nested admin editor (UI), ~⅓ schema/validation/contract plumbing (recursive `define_collection`, `list_field_types`, generated-client types), ~⅓ the querying story you pick (leave opaque / GIN / shadow).

**Phasing:** fixed-shape repeater first; polymorphic **page-builder blocks** (sections of varying shapes) are a bigger, later tier.

**Open questions at build time:** sub-field types allowed (scalars only? asset/relation?); delivery visibility (whole-field vs per-sub-field); search over nested text; item cap + reorder; how the contract teaches nesting; localized-inside-a-list (probably out); migration when toggling a field to/from `list`.

**Decision rule for modelers:** owned by one record, edited together, small-N, not queried on its own → embedded `list`. A real entity, shared or queried independently → child collection + relation (exists today).

## NOTIF-1 · In-app notification center (design — shape decided)

**Decided:** audience *both, phased* — in-app center first, email later once OPS-1 (platform mailer) exists. v1 covers **new submissions, failed deliveries, cap & billing, agent destructive actions**.

**Shape:** one control-plane `notifications` table every producer writes to (delivery-failure path, caps check, billing webhook, suspend action, submission intake); a **bell + feed** in the top bar's slot (unread badge, mark-read, click-through). Channels (Slack/Discord, then email) become additional sinks off the same event — model the event once. It's the tenant-side mirror of the console's "needs attention." Ready to spec/build on a go.

## PLUG-1 · AI-registered tools (design — post-launch)

**North star (operator's words):** *"allow the agent to register plugins if they like."* That's **V1** — the agent registers a new tool at runtime pointed at the tenant's own signed HTTPS endpoint. It's the write-hook model generalized from "gate a write" to "add a verb"; same signing, same fail-closed, same **never-host-tenant-code** boundary.

**Layering:** V1 is the foundation → **blueprints** can carry tool defs (templates gain verbs) → a **V0 marketplace** becomes "publish a bundle of V1 tools." V2 (we host/run tenant code) stays out — different product.

**The crux to design carefully:** letting the *agent* choose where data flows is a data-exfiltration vector distinct from code execution (a prompt-injected agent could register a tool pointed at an attacker endpoint). Mitigation is **endpoint governance**, not sandboxing — default to **tenant/operator-pre-approved domains**, human-in-the-loop for anything outside them. Build it in from day one, not as a bolt-on.

## BILL-1 · Tenant subscription commerce (audit #13 + dogfood)

**First, the distinction** (verified in code):
- **Platform billing** (Pluggie's own revenue) already does subscriptions — `createSubscriptionCheckout` uses `mode:"subscription"` (`lib/platform-billing.ts`). Not this item.
- **Tenant checkout** (`POST /v1/checkout` → `createCheckoutSession`, `lib/stripe.ts:148`) is hardcoded **`mode:"payment"`**. One-time purchases only. This item.

**The gap:** a tenant building SaaS/membership/recurring products on AgentX can only sell one-off purchases to their customers.

**It's a cluster, not a mode flip:**
1. **Subscription-mode sessions** — `createCheckoutSession` gains `mode:"subscription"` when a collection is marked recurring; the existing `priceField` (`price_…`) just has to point at a *recurring* Price. Needs a Stripe Customer (email at minimum) for the recurring relationship.
2. **Subscription lifecycle** — today K4 maps one-time `checkout.session.*` → an order entry (pending→paid). Subscriptions need the recurring lifecycle (`customer.subscription.created/updated/deleted`, `invoice.paid/payment_failed`) → a subscription-shaped mapping (status active/past_due/canceled, current period, renewal) instead of a one-shot order flip. **This is the bulk of the work.**
3. **Customer portal** — subscribers must self-manage/cancel → a Stripe billing-portal session endpoint. *Pluggie's own billing lacks this too — build once, use for both.*
4. **Member-gated commerce (related, audit #13 tail)** — checkout requires public-read collections today, so gated/member-only products are impossible. Subscriptions are usually gated (subscribe → access), so this pairs naturally: allow checkout on non-public collections with an authenticated buyer.

**Sizing:** meaningfully bigger than one-time checkout — the recurring lifecycle + portal, not just the session mode. This is "the SaaS market" the review flagged.

---

## Recently shipped from this pipeline
- **DM-1 structured fields + blocks** (2026-07-15/17) — group/array primitives, repeater editor, heterogeneous block types + `define_block` library.
- **Feedback wall first triage → 5 fixes + 1 security fix** (`6256c51`, `748d7f9`, `b1000e6`, 2026-07-18): workflow-drop confirm gate, relation stale-read → E_VALIDATION, create-null symmetry, workflow import escape hatch (audit-stamped), export keyset cursor, MCP-token-on-delivery scope enforcement. Full story: [reviews/FEEDBACK-TRIAGE-2026-07.md](reviews/FEEDBACK-TRIAGE-2026-07.md).
- **Batch delivery reads** (`POST /api/v1/batch`, 2026-07-17) — the read half of WP-7.
- **Platform billing customer portal** (`0bf5fb0`) — a subscriber can self-manage/cancel via the Stripe Billing Portal from project Settings → Billing. (Proves the portal pattern BILL-1 #3 reuses for tenant-commerce subscriptions.)
- **SEC-2** — connector secret-shape guard (`e59d13e`).
- (Contract dump tooling `scripts/dump-contract.ts` → `docs/ai-contract.md` exists as the DX-2 starter; the contract is now regenerated as part of the ship ritual — see CLAUDE.md.)
