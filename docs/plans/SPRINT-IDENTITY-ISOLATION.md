# Sprint — Identity & Isolation

> **Living — last synced 2026-07-31.** The plan of record for this sprint.
> Protocol: [../pm/BURNDOWN.md](../pm/BURNDOWN.md) · board: [../pm/BOARD.md](../pm/BOARD.md)
> · spec for each item: the cited row in [../BACKLOG.md](../BACKLOG.md).

## Why these items are one sprint

Every item lives in the same three files — `lib/access.ts`, `lib/access-rules.ts`,
and the access half of `lib/mcp/tools.ts` — and they share **one hand-applied
migration**. The theme is a single question: **who can see what, and can you
prove it?**

The sprint was assembled from two sources: open backlog rows in the
multi-tenancy cluster, and five findings from the 2026-07-31 session that were
dispositioned into the backlog before this plan was written (MT-7, DX-8, SEC-4,
CONTRACT-2, plus evidence on MT-6). Nothing here is new scope invented at plan
time.

**It also de-risks the next sprint.** DX-8 makes an access failure legible, and
the Clerk production move — Sprint 2 — fails exactly by making people lose a
rung. Doing DX-8 after the cutover would mean debugging it blind.

## What we are NOT doing, and why

| | Reason |
|---|---|
| **MT-6** (end-user JWT for the build loop) | Its trigger reads *"ENV-1 staging exists (the safe place to mint test identities), or a second integrator reports shipping without being able to verify isolation."* Neither has fired as written, and minting test identities genuinely wants a safe environment first. Lands in Sprint 2 with ENV-1. MT-7 addresses the operator-visible symptom cheaply in the meantime. |
| **The Clerk re-key script** | Operator judgement 2026-07-31: low risk at current scale (8 workspace identities, 3 project members, all with emails). Recorded as a prerequisite of the cutover on the ENV-1 row, not sprint scope. |
| **Moving console identity to a session claim** | Would remove a Clerk Backend API round trip per admin page load — real, but it couples authorization to per-instance dashboard config, which is precisely what breaks on the production move. Revisit after, and only with a `currentUser()` fallback. |
| **Platform-side credential verification** (SEC-3) | Trigger-parked by decision. SEC-4 encrypts what we already store; it does not make us an identity provider. |

## Checkpoints

Each is one coherent batch → gate → commit → push, per BURNDOWN. Target 60–90
minutes. Every fix lands with a test, and every absence/refusal test gets a
**negative control** — break it, watch the named test fail, restore.

### CP1 — MT-2: org-scope the admin view (+ PLUG-4 rides the migration)

**The migration goes first so the rest of the sprint builds on the final schema.**

The gap, verified rather than assumed:

- `layout.tsx:36` — `if (!project || !role) notFound()`. Access is binary; `role`
  then selects *settings vs content*, never rows.
- `[collection]/page.tsx:39` — `queryEntries(collection, { limit, offset, where })`
  where `where` is only the quick-search filter. No org clause, `role` never
  passed in, refs resolved as `"trusted"`.
- `[collection]/[entryId]/page.tsx:53` — fetches `WHERE id = entryId AND
  collectionId = …`. **No role or org check**, so a scoped list alone does not
  close it: a known or stale row id opens any org's record and the form saves it.
- `trash/page.tsx:37` — same shape.

**Why it is feature work, not a WHERE clause.** Delivery derives the org from the
END USER's JWT claim (`access.org = {claim, field}` off `X-User-Token`, the
tenant's Clerk). The console authenticates against the PLATFORM's Clerk and
`project_members.clerkUserId`. Two identity spaces — and `project_members` is
`{projectId, clerkUserId, email, role}`, with **no org column**. The information
the filter needs does not exist yet.

Work:
1. Org binding on `project_members` — **hand-applied migration** (`db:push` is
   broken against Neon PG18).
2. **PLUG-4 rides this migration**: stamp realized collection names on
   `project_plugins` at apply time. Its row says do not run a migration for it
   alone; this is that migration.
3. Apply the scope at **every reachable surface**: list, detail, save/delete
   actions, trash, assets, export, `countEntries`, quick search. Each omission is
   a bypass.
4. **Fail closed** — a client-role member with no binding on an org-scoped
   collection sees nothing, not everything.

Two decisions needed before code (operator):
- **One org per invited member, or several?** One covers client handoff; several
  is what an agency managing several end-clients in one project wants.
- **What does a client see on a collection with NO `access.org`?** Everything
  (today) or nothing? Silent-everything is what produced this row.

Exposure note: measured 2026-07-31, `project_members` holds 9 rows, **all
`operator`, zero `client`** — so there is **no live leak**. This is latent and
fires on the first client handoff. Priority is "before the first handoff", not
"we are leaking".

Tests: the detail-page bypass gets its own case (a scoped list plus a direct id
fetch), and the fail-closed default gets a negative control.

### CP2 — MT-7 + MT-4 + CONTRACT-2: the schema contract tells the truth up front

All three are description/response copy in one file, with no behavior change
except MT-4's gate.

**MT-7 (H) — the thing the operator keeps personally fielding.** A
`{claim,equals}` or `access.org` rule reads a claim that only exists if the
tenant configures it in THEIR Clerk. The contract never says so — `grep` for
"session token template" in `lib/mcp/tools.ts` is **0**, and
`define_collection.access` says only "requires the project's Clerk connector",
which is about connecting the connector. The runtime refusals are excellent and
name the fix (`lib/access-rules.ts:89`, `:51`) — but they arrive days later, to a
human, because the gate is fail-closed so the collection "works" as *nobody can
read this* until someone tests it.

1. An `accessNote` on the define response naming the required claim and the exact
   setup — precedent `a0cfb72`, the publicRead trap note.
2. `define_collection.access` states it: the dashboard path, the literal JSON, and
   that a nested/object claim must be lifted to a flat string.

Ceiling, stated in the row: the dashboard step **cannot** be removed (their IdP,
the D1 decision). This moves it earlier and makes it one clear ask. Worth
checking during CP2 whether Clerk's Backend API exposes the session-token
template — if it does, this becomes a define-time *verification* instead of
advice, which would be strictly better.

**MT-4 (M)** — require `confirm:true` when a redefine drops an existing `access`
block. Template already exists twice (the workflow-drop gate `6256c51`, SEC-1's
publicRead gate). The project-level "policy floor" half stays trigger-parked.

**CONTRACT-2 (H, rescoped 2026-08-04)** — `define_collection` must carry the
field-config vocabulary instead of deferring it to `list_field_types`. **Two
independent field reports, one seam**, both within days of CONTRACT-1 shipping:
the HAV1 run built a correct CAS seat counter and never found `capacity: N`; a
wall `friction` item says enum options and computed date fields "aren't
discoverable from the define_collection tool description alone — needed
trial/error against list_field_types output". Verified: `computed` appears ONCE
and only as an exclusion, `enum:options[]` is a bare token with no shape, and
`indexed`/`writableBy`/`writeOnly` get zero mentions.

**Why CONTRACT-1 missed it, recorded so the next audit does not:** that pass
diffed each description against BEHAVIOR, and by that test `define_collection`
passes — nothing it says is false. The defect is STRUCTURAL, essentials living in
a different tool from the one that needs them, which a behavior-vs-description
diff cannot see. A structural check belongs in the method.

Fix: `define_collection` carries the per-type and common config inline;
`update_entry_if`'s Book-a-seat example names `capacity` and says when each model
is right (counter = "seats remaining on a row"; capacity = "at most N rows sharing
a key", where a cancellation frees a seat with no code); and a **derived** test
asserts every knob in `COMMON_FIELD_CONFIG` is named by `define_collection`, so a
new knob fails the build until both surfaces carry it.

### CP3 — DX-8: an access refusal that diagnoses itself

Four failures are currently indistinguishable behind one `notFound()`: wrong
Clerk instance, a transient Clerk API failure, `ADMIN_EMAILS` missing the address
on that deployment, and the address not being the user's *primary* email. That
bare refusal is what let an agent in the field conclude "Clerk is blocking
backend access, add a `primaryEmail` session claim" — which nothing in the repo
reads, so it would have been a no-op plus a phantom dependency on the production
Clerk instance.

1. Keep the 404 for anonymous callers (project existence must not leak). For a
   **signed-in** user, distinguish "signed in as X, not on any rung for this
   project" from "could not reach Clerk", and record the failed rung in
   `platform_events`.
2. **A Clerk outage must read as an outage.** A null from `currentUser()` is
   currently indistinguishable from "not signed in", and it is called on every
   admin page load via `getProjectRole` → `getViewer` — so a blip 404s the whole
   admin and presents as a permissions problem.

Tests: three cases stay distinguishable, and the anonymous case still leaks
nothing. Negative-control the leak assertion.

### CP4 — SEC-4: encrypt `writeOnly` values at rest — ⏳ DEFERRED, not done

**Re-sequenced 2026-08-04 after tracing the write path, and the reason is
sequencing rather than difficulty.** Encrypting makes tenant CONTENT depend on
`CONNECTOR_MASTER_KEY`, and local dev currently shares that key with production
(ENV-1, verified 07-22). Making stored credentials depend on a key that is
presently mishandled is worse than leaving them plaintext behind an API that
already refuses to return them. So SEC-4 now carries the trigger **"ENV-1 has
shipped with its own master key"**.

Two things found while tracing, recorded on the BACKLOG row so the work is not
redone: nothing ever DECRYPTS a writeOnly value today (reads redact, and the
before-write-hook envelope receives it redacted), so encryption makes it
permanently unreadable by everyone including us — ideal for an unverifiable
password hash, but it turns "recoverable from a DB dump" into "lost forever if
the key is lost", which is an operator decision. And there are five write sites,
one of which merges JSONB in raw SQL on the CAS path.

### CP5 — close out

Doc-sync ritual (CLAUDE.md): regenerate the contract, sync `CAPABILITIES.md` and
bump its dateline, reconcile `BACKLOG.md` with commit hashes, mark this plan's
items shipped inline. `npm run pm`. **Full `npm run verify` before the last
push** — contract changes break tests written for narrower contracts, and only
the full suite catches it.

## Definition of done

- MT-2, MT-7, MT-4, DX-8, SEC-4, CONTRACT-2 shipped with tests and hashes;
  PLUG-4 closed by CP1's migration.
- Every new absence/refusal test negative-controlled.
- `npm run pm` clean: cited commits resolve, no open row named by a commit.
- Sprint 2 (ENV-1 + the Clerk production move) can start without touching
  anything in this sprint's scope.

## Sprint 2 and 3, for orientation only

- **Sprint 2 — Environments.** ENV-1 plus the Clerk production move, together
  (ENV-1 needs its own Clerk instance regardless). Carries MT-6, whose trigger
  ENV-1 fires. Operator-heavy: DNS, keys, a Neon project, an R2 prefix, its own
  master key. **Sprint-sized, not a checkpoint** — five pieces of infrastructure
  plus a schema-sync path `db:push` cannot provide.
- **Sprint 3 — Tenant dev/prod.** QRY-4: entry-level import with id remapping
  (the missing half), `pairedWith`, the console env switcher, Neon copy-on-write
  twins. `dryRun` (DX-7) and `reset_project` (OPS-6) already landed as its
  plan-mode and cleanup pieces.
