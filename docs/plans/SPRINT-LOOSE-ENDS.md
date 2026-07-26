# Sprint — Loose ends: finish what we started

> Initiative plan — written 2026-07-25 at the operator's request: *"unfinished
> work that is not in the backlog that we started but haven't finished."*
> Status marks inline (⬜ / 🚧 / ✅). ⚑ = needs the operator.
>
> **Scope rule:** every item here was **started and left mid-flight**. Ideas we
> never began live in [BACKLOG.md](../BACKLOG.md) and are deliberately absent.
> Sprint items still open in their own plans (D2/D3 in
> [MCP-FRICTION-PLAN.md](MCP-FRICTION-PLAN.md), EE-1 in
> [SPRINT-2026-07-HARDENING.md](SPRINT-2026-07-HARDENING.md)) are cross-linked,
> not duplicated — except where the *unfinished half* is the point.
>
> Total: **~4–5 hours of my work + 4 operator actions.** Nothing here is large.
> That is exactly why it rotted — each piece was too small to schedule and too
> real to forget.

## Track A — Applied but inert (do first: this one can bite)

Both D1 migration columns were applied to **both databases** on 07-23, and then
nothing else happened. They are not in `db/schema.ts`, not written, not read.

✅ **TRACK A DONE 2026-07-25.** Both columns declared in `db/schema.ts`;
`db/migrations/0001_drift-check.sql` added and made **idempotent**
(`ADD COLUMN IF NOT EXISTS`) so it is a safe no-op on the two databases that
already took the hand-applied path — verified by re-running it against the test
DB. `drizzle-kit generate` now reports *"No schema changes, nothing to
migrate"*; `tsc` clean.
⚠️ **Correction to the risk as first written:** I said a future
`drizzle-kit generate` would emit DROPs. That was too strong — the generated
diff contained only ADDs. The real exposure was narrower but genuine: a **fresh
bootstrap from the migrations folder** (exactly how the test DB was built)
would have **omitted both columns**, silently diverging test from production.
Closed either way; recorded so the reasoning is not inherited wrong.

*The features on top of these columns remain unbuilt — expiry enforcement rides
with D2 below; PLUG-4's write-side still needs its "when is apply finished?"
design pass.*

- ✅ **A1 — `project_tokens.expires_at` is a column with no meaning.**
  Verified 07-25: present in prod and test DBs, **absent from `db/schema.ts`**,
  zero references in `lib/` or `app/`. Nothing sets it; `resolveToken` never
  checks it. Every token is still non-expiring.
  🛑 **The real risk is DRIFT, not the dead feature.** `db/schema.ts` is
  drizzle's source of truth. The next `drizzle-kit generate` (we ran one on
  07-23 to bootstrap the test DB — it is now a normal tool in the workflow)
  would see columns in the DB that the schema does not declare and emit a
  migration that **DROPS them**. A future bootstrap could quietly delete token
  expiry and plugin ground-truth.
  *Finish:* add both columns to `db/schema.ts` (~10 min, no behavior change,
  kills the drift), then decide whether expiry enforcement rides with D2 or
  ships standalone.
- ✅ **A2 — `project_plugins.realized_names` (PLUG-4) is unwritten.**
  Same drift. Also means **PLUG-3's applied-state is still the heuristic** —
  the `unclear` middle state we shipped, with the "countryside_crm scores 5/6
  on CSLP because `reps` became `users`" caveat. Stamping realized names at
  apply time was the durable fix; the column is ready and unused.
  ⚠️ *Open design question, unresolved since 07-23:* "apply" is not one event —
  an agent reconciles a baseline over several `define_collection` calls. Decide
  where the stamp is written (at `enable_plugin` re-acknowledgement, or
  incrementally as defines land) before coding.

## Track B — Shipped but never verified

Code that is live in production and has never been exercised on the path that
matters. Not known-broken; **unproven**, which is worse than untested because
it reads as done.

- ⬜ **B1 — the "Switch to X" provider button has never been clicked.**
  EE-1's swap path (`categoryConflict` + `saveConnector({swap:true})` + the
  card button) is typechecked, its page compiles, and the server logic is
  covered — but the **browser interaction was never run**, because the admin
  console needs an operator Clerk session I do not have. It is the one
  unexercised branch of the entire EE-1 fix.
  ⚑ *Finish:* one manual click on a throwaway project (~2 min). Connect a
  second email provider, confirm the refusal offers "Switch to…", click it,
  confirm the old provider is gone and the new one is `connected`.
- ⬜ **B2 — the cron retry may not be armed.**
  Committed and pushed 07-25 (`1d5b21a`). All three paths were verified
  locally (success, unreachable ×3, fail-fast on 401) — but a `startCommand`
  change in `render.yaml` only takes effect when Render **re-syncs the
  Blueprint**, and that has not been confirmed.
  ⚑ *Finish:* check the cron's Runs tab after the next deploy. Green ticks
  through a restart (or logs reading `drain 200 attempt 2`) = armed. Another
  red streak = hit sync in Render.

## Track C — 🅿️ PARKED (operator decision, 2026-07-25)

**Parked by the operator:** *"I manage Stallion Construction… and the Elastic
Email, I'll just review that at once. Currently we're all using Resend."*
✅ **Verified clean to park:** `elastic_email` connectors platform-wide = **0**
(the Codex-test connection was removed), so nothing is left half-wired and no
project depends on the unproven adapter. The EE code fixes stay shipped and
inert until someone connects EE again.
📌 **One factual note for whenever it is picked up:** Stallion's 8 dead emails
are a **Resend** domain-verification failure (`dinodigi.com is not verified`),
not an Elastic Email one — so parking EE does not park that. It is the
operator's own client and their call; recorded here only so the cause is not
re-diagnosed from scratch later.

<details><summary>Original Track C detail (retained for pickup)</summary>

- 🚧 **C1 — EE-1's send proof.** Three of four defects fixed and verified
  against the operator's real key (probe rewritten to parse EE's error body,
  connect-time validation, swap path). **The v4 wire shape has still never
  been exercised** — `Recipients`/`Content`/`Body[]` is unproven against the
  live API. Blocked: the Elastic Email account has **zero verified domains**.
- ⬜ **C2 — Stallion Construction's 8 dead notification emails.**
  Diagnosed 07-22: all 8 failed deliveries are
  `Resend HTTP 403: "dinodigi.com is not verified"`, dating to 2026-07-15.
  **A live client's notifications have been silently dead for 10 days.** This
  is the oldest unfinished thing in the repo and the only one with a customer
  on the other end.
  ⚑ **One action closes both:** verify `dinodigi.com` (SPF/DKIM) in Resend AND
  Elastic Email. Not code. After that, C1 is a 5-minute test send and C2
  self-heals on the next event.

</details>

## Track D — Half-drained

- 🚧 **D1 — orphan smoke projects: 185 → 48.**
  The *leak* is fixed (the sweep in `createEphemeralProject`, bounded 25/call,
  2h age guard, exact-name-shape guard). The backlog is draining itself ~25
  per suite run and is now at **48**. Two more full suite runs finish it.
  *Finish:* nothing to build — just do not mistake "48 rows" for a bug. It
  converges. Re-check after the next `npm run verify`.

## Track E — Bookkeeping debt (highest value per minute)

✅ **TRACK E DONE 2026-07-25.** All 20 rows dispositioned with a **receipt in
the note** (commit hash, or the verification that settled it) — `new` is now
**0**. Closed 17; kept 3 as `planned`: DX-7 (browser-safe public reads) and the
two Hatchly findings, both of which were **re-verified true against the code**
before being kept open rather than taken on report alone. Two rows are recorded
as *reporter was right, platform was at fault* (the base-URL poisoning), and
two as *contradicted* (CORS), so the trail stays honest in both directions.

- ✅ **E1 — reconcile the feedback wall: it currently lies.**
  20 rows read `new`; **18 are already resolved or answered** — fixed
  (image-resizer 429s, SEO title length, both token-unreachable, both
  deletion-visible, `searchable`-after-redefine, all three 404s via `APP_URL`,
  `id`/`tokenId`, console token lag), investigated-and-answered (workflow
  transitions = no bug, `delete_asset` = premise wrong, CORS = contradicted),
  or an endorsement (`keep MCP + minting as the canonical path`).
  **Only 2 are genuinely open** (Track G).
  *Why it matters:* the wall is the operator's triage instrument and our
  dogfood signal. A dashboard that reads 20-when-it-is-2 trains you to ignore
  it — and the next real report arrives into noise. Dispositions with receipts
  are already written in the two sprint plans.
  *Finish:* ~15 min, by SQL with the commit hash in each note, or by clicking
  through the console.

## Track F — Thinking done, artifact missing

- ✅ **F1 — XVibe: PROMOTED TO ITS OWN SPRINT 2026-07-25.**
  Operator: *"XVibe is a big, big project on its own."* Correct — it is a
  second product, not a loose end. All conversation-only decisions are now
  captured in **[XVIBE-PLAN.md](XVIBE-PLAN.md)**: the static-heads boundary,
  Path C's rented Worker runtime with its abuse/cost/support gates, Phase 1 =
  the in-console "Build & deploy" button (shared session, project exists),
  Phase 2 = the standalone front door, the swappable-entry-point design rule,
  D3/OAuth as the hard prerequisite, and the open pricing/positioning question.
  It also formally supersedes the 2026-07-20 park decision.
- ⬜ **F2 — the D2 scope vocabulary is designed but unsigned.**
  Six scopes drafted in MCP-FRICTION-PLAN + three corrections raised on review
  (schema *reads* move to `observability.read` or a content-only token cannot
  orient; `import_project` belongs to `schema.manage` since it creates
  collections; the `content.write` consent line must say **delete**, because
  the group includes irreversible purge). Nothing is built and nothing is
  decided — and D3's consent screen plus its grant tables both depend on it.
  ⚑ *Finish:* operator sign-off (or reshape). This is the single decision
  gating the largest remaining piece of roadmap.

## Track G — Field debt with no home (NOT started — listed so it is not lost)

Two reports from a Hatchly session, 2026-07-24, stamped on the current deploy.
Both are real and neither is in any plan or backlog. Included because they have
nowhere else to live; **not** claimed as started work.

- ⬜ **G1 — `define_collection` has no additive field op.** Adding one field
  means re-sending the whole schema, and any omission is a destructive removal.
  **This changed a real design decision:** the reporter wanted a `burn` field
  on the `transactions` ledger and *did not add it*, judging a full re-declare
  of a collection with unique + computed fields too risky. Friction that alters
  what gets built is the most expensive kind we log.
- ⬜ **G2 — the two read planes disagree.** MCP reads are fresh (friction
  sprint A1); the delivery API converges ~15s later **and** enforces
  `publicFilter`, so the surfaces disagree on both timing and row visibility.
  User-facing effect: a just-created `quick_ideas` row was present over MCP and
  absent from the public board — a post looked "silently discarded." They
  quoted our own A2 convergence note back at us.
  🔗 **Third independent signal on the cache**, after the outside architecture
  review ("five fresh-on-X carve-outs is the smell of a cache not earning its
  keep") and our own sprint adding yet another carve-out. Cheap experiment:
  measure what a 2s TTL actually costs now that Cloudflare absorbs the read
  volume.

## ✅ Verification round — 2026-07-25 (operator-requested)

*"We need another round of verification when it comes to all these things on
the sprint."* Every remaining item re-checked against live code and the
production DB rather than restated from memory. Results:

| Item | Re-verified | Result |
|---|---|---|
| A1/A2 drift | `grep expiresAt\|realizedNames db/schema.ts` | **0 hits — drift CONFIRMED still present.** Columns live in both DBs, absent from the ORM schema. |
| D1 orphans | live count | **48** (was 185 → 48). Sweep is draining as designed; unchanged since the last suite run. |
| E1 wall | live counts | **20 `new`, 18 `done`, 14 `planned`, 2 `reviewed`** — the 20-vs-2 gap confirmed. |
| C (parked) | `elastic_email` connector count | **0 platform-wide** — nothing half-wired; clean to park. |
| G1 additive op | searched the tool surface for any add/patch/alter-field verb | **None exists — claim TRUE.** Full-replace is the only path. |
| G2 read planes | `lib/collections.ts` TTL + MCP tool docs | **Claim TRUE, and self-documented:** delivery reads carry `revalidate: 15`, and our own tool description states MCP reads apply *"any MCP read (publicFilter/access do not apply)"* — the asymmetry is by design and undocumented to tenants. |
| B1 swap button | — | **Still unverifiable by me** (needs an operator Clerk session). Unchanged. |
| B2 cron retry | — | **Still unconfirmed** (needs Render's Runs tab post-deploy). Unchanged. |

Nothing in the list was found stale or already-fixed. The two field claims
(G1/G2) survive scrutiny and are now evidence-backed, not reported-only.

## Suggested order (my recommendation, not a decision)

*(Revised 07-25 after the operator parked C and promoted F1.)*

1. **A1 + A2 schema drift** — 10 minutes, removes a footgun that could silently
   drop two production columns.
2. **E1 reconcile the wall** — 15 minutes, and your instrument tells the truth
   again (20 → 2).
3. **⚑ B1 + B2** — two small manual confirmations that turn "shipped" into
   "proven."
4. **F2 sign-off** → unblocks D2/D3, the actual roadmap, which in turn is
   XVibe's Phase 0.
5. **G1/G2** — schedule deliberately. G2 deserves the **cache measurement**
   rather than a fourth fresh-read carve-out; G1 is an API-design decision
   (an additive op) worth its own short design pass.
6. ~~Track C~~ — 🅿️ parked. ~~F1~~ — ✅ promoted to
   [XVIBE-PLAN.md](XVIBE-PLAN.md).

## Deliberately NOT here

- Anything in [BACKLOG.md](../BACKLOG.md) — never started (DX-6 OAuth is the
  exception only because D2/D3 are mid-flight in their own sprint plan).
- **Adversarial concurrency tests** and **the cache TTL measurement** — raised
  by the 07-24 outside review, genuinely valuable, but never begun. They belong
  in the backlog, and G2 is the field evidence that the cache one is real.
- **Clerk dev→prod instances** (platform + 11 tenant projects) — a launch
  chore, not started work. Backlog it with the DNS steps.
