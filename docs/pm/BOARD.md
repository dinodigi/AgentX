# Board — everything open, in one list

> The full task list. **[STATUS.md](STATUS.md)** is the one-page "what now";
> this is the complete inventory behind it.
>
> The wall section is generated — run `npm run pm` to refresh it from the live
> database. Everything else is hand-maintained.

## Sprint tracks — burn-down ledger

> **GENERATED** — `npm run pm` rebuilds this from the feedback wall's receipts.
> It used to be hand-maintained and drifted badly during the very session that
> shipped the work (13 items still reading open after they were closed), which
> is the same "the board lies" failure the wall itself had. Anything derivable
> from the database is now derived from it.

Protocol: **[BURNDOWN.md](BURNDOWN.md)** · dispositioned queue: **[QUEUE.md](QUEUE.md)**

<!-- BEGIN:LEDGER -->
_42 closed with a receipt the reporter can read. ✅ shipped · 📝 answered · ⏳ deferred with a trigger · 🚫 declined._

| | id | project | item | receipt |
|---|---|---|---|---|
| ✅ | `16d745d3` | CSLP | Docs say publicWrite POST is 'anonymous', but a truly tokenless POST returns 401 E_AUTH - 'anonymous' actually | `8d63719` |
| 📝 | `2bdec2b0` | CSLP | Unauthenticated GET on an access-ruled collection returns 404 E_NOT_FOUND instead of 401/403 - fail-closed is  | `43d0cd9` |
| ✅ | `2684fec0` | CSLP | No date bucketing and no second groupBy dimension - by-month pipeline, closed volume by rep by month, tours by | `0ee45c9` |
| ✅ | `8570cb24` | CSLP | No counting/capacity constraint: unique gives exactly-one-per-key, but 'max N rows per composite key' (e.g. to | `bea3377` |
| ✅ | `a61039c4` | CSLP | Workflow actors are too coarse: 'admin' includes client-role members (v1), so anyone invited to the admin UI c | `2798606` |
| ✅ | `73a14ef7` | CSLP | Enum option renames have no mapped migration - renames:[] covers fields only, so renaming a pipeline stage or  | `260e64b` |
| ⏳ | `de626cb6` | CSLP | No SMS connector (Twilio etc.) although the countryside_crm baseline ships text_opt_in - the platform stores a | reopens: a second project asks, or one client commits to SMS |
| ✅ | `4847bc14` | CSLP | op 'ne' never matching unset fields is correct but surprising, and the anyOf:[{ne},{exists:false}] idiom for ' | `0dbf3ff` |
| ✅ | `1c10d760` | CSLP | 100 rows/call makes real migrations chatty (3.1k-lead Salesforce import = ~31 sequential calls) - a streaming/ | `f5a99f7` |
| 📝 | `5e8146d8` | CSLP | Some MCP-path error hints use delivery-facing wording - e.g. writableBy rejections say 'remove them or sign in | `0dbf3ff` |
| ⏳ | `42a6d515` | CSLP | countryside_crm ships tools:[] — building a full CRM on it meant re-implementing every domain operation in app | reopens: after the wall is clear (plugin-authored tools, PLUG line) |
| ✅ | `0a5ce08c` | Fatsoz | `indexed` is rejected on date fields, so the most natural sort/filter dimension for events and submissions (a  | `2dfa814` |
| ✅ | `95b660d1` | Fatsoz | The stateless MCP-over-HTTP transport is excellent for server-side use — worth documenting it as a supported p | `66ad28e` |
| ✅ | `4fae3449` | Hatchly | query_entries rejects `id` in where clauses ("unknown field id"), so fetching one entry by id needs a separate | `0dbf3ff` |
| ✅ | `66d1cbd9` | Codex-test | Add a browser-safe public-read mode for public collections. | `57bbea4` |
| ✅ | `9c2333cb` | Hatchly | define_collection has no additive field op — adding one field requires re-sending the whole schema, and any om | `f5a99f7` |
| ✅ | `e9628701` | Hatchly | Two read planes disagree: MCP reads reflect writes immediately, but the delivery API converges ~15s later and  | `66ad28e` |
| ✅ | `58aaca1e` | xvibe | briefing.health reports r2/clerk/resend connectors as "error" on project xvibe while R2 demonstrably works end | `65fa439` |
| ✅ | `e0b6eb32` | xvibe | A collection cannot combine anonymous form intake (publicWrite POST) with claim-gated delivery PATCH, because  | `8d63719` |
| ✅ | `921f9ec7` | xvibe | get_client_code generated no update()/remove() methods for a collection whose access.write is a claim rule, ev | `65fa439` |
| ✅ | `eff3e105` | xvibe | XVibe-class static apps need an edge proxy solely to hold the delivery token — a browser-safe, read-only+publi | `57bbea4` |
| ✅ | `a1fb8001` | jabed test | publicFilter cannot express relative time, so "serve this row only while now is between starts_at and ends_at" | `279d70e` |
| ✅ | `ad690ade` | jabed test | Relation and asset sub-fields inside typed blocks reject an explicit null — the key must be omitted entirely — | `0dbf3ff` |
| ✅ | `34acd74d` | jabed test | indexed is rejected on date fields, but published_at is the canonical sort key for any content collection — th | `2dfa814` |
| ✅ | `d128f35a` | jabed test | bulk_create_entries takes bare objects while create_entry takes {collection, data:{...}} — the asymmetry betwe | `0dbf3ff` |
| ✅ | `cbf4db8f` | jabed test | Array fields cannot be filtered on the delivery API, so a tag archive has to fetch every post and filter in me | `47ed83e` |
| ✅ | `6809681c` | jabed test | Workflow transitions gate on ACTOR but not on row state, so "you may not launch a campaign that has no creativ | `346cdd4` |
| ✅ | `9c61bc7a` | jabed test | Entry writes are not immediately visible on the delivery API and nothing documents that, so my first read afte | `66ad28e` |
| ✅ | `1a24b96b` | jabed test | update_entry_if increment refuses an unset field, so every counter needs a seed-or-fallback path — and the fal | `0dbf3ff` |
| ✅ | `75f9f4f7` | jabed test | The workflow docs note that the 'admin' actor includes client-role members, which quietly means an actor-gated | `2798606` |
| ✅ | `74e7016d` | jabed test | The MCP endpoint is stateless — tools/call works with no initialize handshake or session id — which let me wri | `66ad28e` |
| ⏳ | `6e5af8cd` | xvibe | New connector category: tenant-stored third-party API credentials (OpenAI/Twilio/SendGrid-class) invocable fro | reopens: a tenant asks for a SPECIFIC credential category (llm, sms, …) |
| ✅ | `0cd6dce5` | xvibe | No declarative way to stamp a field on a workflow transition (e.g. resolved_at = now when status transitions t | `91edc77` |
| ✅ | `21f4c5d5` | xvibe | publicRead naming misleads on access-gated collections: an agent set access.read=authenticated and (reasonably | `a0cfb72` |
| ✅ | `ad7568ba` | xvibe | No one-call project reset: wiping a burn/test project takes N delete_collection calls in dependency order (E_B | `60d4c59` |
| ✅ | `61f9b82e` | xvibe | dryRun on define_collection (validate + full diff plan, apply nothing) — transact already has dryRun; define o | `6992092` |
| ✅ | `2479b787` | xvibe | Machine-readable not-supported registry in the session briefing: a short list of known unsupported capabilitie | `a0cfb72` |
| 📝 | `15e5783b` | xvibe | Contract docs contradict live behavior on publicWrite + access.write: docs say a non-none access.write REPLACE | `d0a7f89` |
| 📝 | `5e7ff188` | xvibe | probe_app returns 401 E_AUTH on a publicWrite/publicRead collection even after mint_delivery_token reports the | `retracted by 30cf6659` |
| 📝 | `30cf6659` | xvibe | Retraction of builder-filed report: probe_app 401-after-mint was an XVibe-side custody bug, not a platform iss | `ack` |
| ✅ | `89053b98` | xvibe | define_collection field config for enum options and computed date fields isn't discoverable from the define_co | `2339e32` |
| ✅ | `c91e2872` | xvibe | define_collection's addFields silently dropped the collection's `access` and `workflow` config instead of leav | `2339e32` |
<!-- END:LEDGER -->

## Carried from earlier sprints

| ID | Item | State | Source |
|---|---|---|---|
| L-B1 | Provider-switch button never clicked in a browser | ⬜ ⚑ | Loose ends |
| L-B2 | Cron retry armed? (check Runs tab after a deploy) | ⬜ ⚑ | Loose ends |
| L-D1 | Orphan smoke projects draining (185 → 48, self-healing) | 🚧 | Loose ends |
| PLUG-4 | `realized_names` write side — needs "when is an apply finished?" | ⬜ | D1 batch |
| OAUTH-R | Refresh-token rotation (OAuth 2.1 requires it for public clients) | ⬜ | D3 |

## Operator queue ⚑

| Item | Why it matters |
|---|---|
| Verify `dinodigi.com` SPF/DKIM | Revives Stallion's dead notification emails **and** unblocks the EE send proof |
| Clerk dev → production instance | Platform + 11 tenant projects on dev instances; $0 to fix, needs DNS |
| UptimeRobot: confirm **keyword** monitors | Post-OPS-3 a status-code monitor is blind to a DB outage |
| Domain decision (trademark) | 4 files + config to change now; far worse after launch |
| D1/D2/D3 design calls | Gate the Track D work |

## Feedback wall — live snapshot

<!-- BEGIN:WALLHEALTH -->
_Wall totals: done=78 · new=5 · planned=2 · reviewed=2_
<!-- END:WALLHEALTH -->

<!-- BEGIN:WALL -->
_7 open (5 new, 2 planned) · 0 theme(s) reported more than once · snapshot 2026-08-07 02:46Z_

| | date | project | kind | item |
|---|---|---|---|---|
| ⬜ | 08-05 | xvibe | limitation | No server-side auto-increment/sequence field type, so a publicWrite "join queue and get… |
| ⬜ | 08-05 | xvibe | limitation | No tool can exercise an authenticated PATCH (write) with a real Clerk JWT — probe_app o… |
| ⬜ | 08-05 | xvibe | bug | Delivery API GET with sort+limit combined together silently drops one row from the result |
| ⬜ | 08-05 | xvibe | limitation | probe_app only issues GET requests (schema: {paths, userToken}), so it cannot verify au… |
| ⬜ | 08-07 | EasyFilm | limitation | Text inside an array-of-group field is unsearchable — no index, no full-text, and `sear… |
| 🗓️ | 07-31 | xvibe | idea | Project branches backed by Neon branching: branch a project (schema + data), work again… |
| 🗓️ | 08-01 | xvibe | limitation | User asked for SMS appointment reminders; SMS sending is not available (event actions a… |
<!-- END:WALL -->

## Backlog — decided-or-parked, NOT started

<!-- BEGIN:BACKLOG -->
_14 scheduled (8 high) · 23 closed-with-a-condition (⏳ trigger / ⚑ operator) · full detail in [../BACKLOG.md](../BACKLOG.md)_

**Scheduled = decided, not started.** A sprint is a commitment; this is a list. High priority:

| | ID | item |
|---|---|---|
| 📥 | **CONTRACT-3** | An integrator cannot discover TIER STRUCTURE from the agent surface, and has no channel  |
| 📥 | **DM-5** | Text inside an array/group is unsearchable — the flagship use case for the container shi |
| 📥 | **ENV-1** | Staging environment — an online copy of the platform to debug against (operator, 2026-07 |
| 📥 | **MT-2** | Org-scope the admin view — an invited client-role member sees every org's rows in the ad |
| 📥 | **MT-6** | A way to test isolation from the build loop (mint/supply an end-user JWT, or an isolatio |
| 📥 | **OPS-2** | Breaking-change comms. *(Re-scoped in CP10: the AGENT half shipped in the friction sprin |
| 📥 | **QRY-4** | Entry-level import + project environments (`import_project` is schema-only). H: named bl |
| 📥 | **WP-7** | Bulk write + delete on the delivery API. Bulk ops are MCP-only, so a delivery-side clien |

_…plus 6 scheduled at M/L, and 23 ⏳/⚑ rows that reopen on their named condition._
<!-- END:BACKLOG -->

## Not in any sprint (deliberate)

- **Adversarial concurrency tests** — CAS, `SKIP LOCKED`, schedule ticks. Real
  risk, never started. Backlog, not a loose end.
- **Cache TTL measurement** — three independent signals now say the 15s window
  is fighting the product. Measure before adding a fourth carve-out.
- **Secret-field `publicRead` guard** — refuse `publicRead` on fields named like
  secrets (found during the Stallion auth investigation).
- **Elastic Email send proof** — 🅿️ parked by the operator; nothing depends on it.
- Everything in **[../BACKLOG.md](../BACKLOG.md)** — ideas, never started.
