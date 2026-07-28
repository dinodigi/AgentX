# Board — everything open, in one list

> The full task list. **[STATUS.md](STATUS.md)** is the one-page "what now";
> this is the complete inventory behind it.
>
> The wall section is generated — run `npm run pm` to refresh it from the live
> database. Everything else is hand-maintained.

## Sprint tracks — committed work

Current sprint: **[Field signal](../plans/SPRINT-FIELD-SIGNAL.md)** (opened
2026-07-26). Prioritised by *independent confirmation* — issues two or more
unrelated testers hit.

### A · Reported by 2+ testers (do first)

| ID | Item | State | Note |
|---|---|---|---|
| A1 | `admin` workflow actor silently includes client-role members | ⬜ | 🔴 Only security-shaped item. CSLP 07-18 **+** jabed 07-26. Verified in code. |
| A2 | Two read planes disagree; only schema returns a convergence note | ⬜ | Hatchly + jabed + our own G2. Cheap half: add the note to entry writes. |
| A3 | `indexed` rejected on date fields | ⬜ | Fatsoz + jabed. `published_at` has no substitute. |
| A4 | Stateless MCP-over-HTTP undocumented | ⬜ | **3 reporters.** Cheapest item on the board. |
| A5 | Anonymous intake cannot coexist with gated writes | ⬜ | CSLP + xvibe. Most common shape on the platform needs 2 collections. |

### B · Cheap ergonomics

| ID | Item | State |
|---|---|---|
| B1 | `bulk_create_entries` / `create_entry` shape asymmetry + misleading error order | ⬜ |
| B2 | Typed-block sub-fields reject explicit `null` without hinting "omit the key" | ⬜ |
| B3 | `query_entries` rejects `id` in where clauses | ⬜ |
| B4 | MCP-path errors use delivery-facing wording | ⬜ |
| B5 | `increment` refuses an unset field; the workaround loses the first count | ⬜ |

### C · Scaling traps (ship fine, fail after a customer invests)

| ID | Item | State |
|---|---|---|
| C1 | Array fields cannot be filtered on the delivery API | ⬜ |
| C2 | `publicFilter` cannot express relative time | ⬜ |
| C3 | No date bucketing / second `groupBy` dimension | ⬜ |

### D · Design decisions ⚑ (need the operator)

| ID | Item | State |
|---|---|---|
| D1 | `auth_kit` leaves credential handling to every tenant | ⬜ ⚑ |
| D2 | Workflow transitions gate on WHO, never on WHAT | ⬜ ⚑ |
| D3 | A browser-safe delivery credential (XVibe runs a proxy just to hold a token) | ⬜ ⚑ |

### E · Bugs — reproduce first

| ID | Item | State |
|---|---|---|
| E1 | `briefing.health` reports connectors as `error` while they demonstrably work | ⬜ |
| E2 | `get_client_code` omits `update()`/`remove()` for claim-write collections | ⬜ |

## Carried from earlier sprints

| ID | Item | State | Source |
|---|---|---|---|
| G1 | `define_collection` has no additive field op | ⬜ | [Loose ends](../plans/SPRINT-LOOSE-ENDS.md) |
| G2 | Two read planes disagree | ⬜ | Loose ends — merged into A2 |
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
_Wall totals: done=35 · new=15 · planned=17 · reviewed=2_
<!-- END:WALLHEALTH -->

<!-- BEGIN:WALL -->
_32 open (15 new, 17 planned) · 1 theme(s) reported more than once · snapshot 2026-07-28 07:26Z_

| | date | project | kind | item |
|---|---|---|---|---|
| ⬜ | 07-26 | xvibe | bug | briefing.health reports r2/clerk/resend connectors as "error" on project xvibe while R2… |
| ⬜ | 07-26 | xvibe | limitation | A collection cannot combine anonymous form intake (publicWrite POST) with claim-gated d… |
| ⬜ | 07-26 | xvibe | friction | get_client_code generated no update()/remove() methods for a collection whose access.wr… |
| ⬜ | 07-26 | xvibe | idea | XVibe-class static apps need an edge proxy solely to hold the delivery token — a browse… |
| ⬜ | 07-26 | jabed test | limitation | auth_kit is credential-free by design, so every tenant hand-rolls password hashing, loc… |
| ⬜ | 07-26 | jabed test | limitation | publicFilter cannot express relative time, so "serve this row only while now is between… |
| ⬜ | 07-26 | jabed test | friction | Relation and asset sub-fields inside typed blocks reject an explicit null — the key mus… |
| ⬜ | 07-26 | jabed test | limitation | indexed is rejected on date fields, but published_at is the canonical sort key for any … |
| ⬜ | 07-26 | jabed test | friction | bulk_create_entries takes bare objects while create_entry takes {collection, data:{...}… |
| ⬜ | 07-26 | jabed test | limitation | Array fields cannot be filtered on the delivery API, so a tag archive has to fetch ever… |
| ⬜ | 07-26 | jabed test | idea | Workflow transitions gate on ACTOR but not on row state, so "you may not launch a campa… |
| ⬜ | 07-26 | jabed test | friction | Entry writes are not immediately visible on the delivery API and nothing documents that… |
| ⬜ | 07-26 | jabed test | idea | update_entry_if increment refuses an unset field, so every counter needs a seed-or-fall… |
| ⬜ | 07-26 | jabed test | friction | The workflow docs note that the 'admin' actor includes client-role members, which quiet… |
| ⬜ | 07-26 | jabed test | idea | The MCP endpoint is stateless — tools/call works with no initialize handshake or sessio… |
| 🗓️ | 07-18 | CSLP | friction | Docs say publicWrite POST is 'anonymous', but a truly tokenless POST returns 401 E_AUTH… |
| 🗓️ | 07-18 | CSLP | friction | Unauthenticated GET on an access-ruled collection returns 404 E_NOT_FOUND instead of 40… |
| 🗓️ | 07-18 | CSLP | limitation | No date bucketing and no second groupBy dimension - by-month pipeline, closed volume by… |
| 🗓️ | 07-18 | CSLP | limitation | No counting/capacity constraint: unique gives exactly-one-per-key, but 'max N rows per … |
| 🗓️ | 07-18 | CSLP | limitation | Workflow actors are too coarse: 'admin' includes client-role members (v1), so anyone in… |
| 🗓️ | 07-18 | CSLP | limitation | Enum option renames have no mapped migration - renames:[] covers fields only, so renami… |
| 🗓️ | 07-18 | CSLP | limitation | No SMS connector (Twilio etc.) although the countryside_crm baseline ships text_opt_in … |
| 🗓️ | 07-18 | CSLP | friction | op 'ne' never matching unset fields is correct but surprising, and the anyOf:[{ne},{exi… |
| 🗓️ | 07-18 | CSLP | friction | 100 rows/call makes real migrations chatty (3.1k-lead Salesforce import = ~31 sequentia… |
| 🗓️ | 07-18 | CSLP | friction | Some MCP-path error hints use delivery-facing wording - e.g. writableBy rejections say … |
| 🗓️ | 07-19 | CSLP | idea | countryside_crm ships tools:[] — building a full CRM on it meant re-implementing every … |
| 🗓️ | 07-20 | Fatsoz | limitation | `indexed` is rejected on date fields, so the most natural sort/filter dimension for eve… |
| 🗓️ | 07-20 | Fatsoz | idea | The stateless MCP-over-HTTP transport is excellent for server-side use — worth document… |
| 🗓️ | 07-20 | Hatchly | friction | query_entries rejects `id` in where clauses ("unknown field id"), so fetching one entry… |
| 🗓️ | 07-23 | Codex-test | idea | Add a browser-safe public-read mode for public collections. |
| 🗓️ | 07-24 | Hatchly | limitation | define_collection has no additive field op — adding one field requires re-sending the w… |
| 🗓️ | 07-24 | Hatchly | friction | Two read planes disagree: MCP reads reflect writes immediately, but the delivery API co… |
<!-- END:WALL -->

## Backlog — decided-or-parked, NOT started

<!-- BEGIN:BACKLOG -->
_44 unshipped (10 high priority) · full detail in [../BACKLOG.md](../BACKLOG.md)_

**These are NOT started.** A sprint is a commitment; this is a list. High priority only:

| | ID | item |
|---|---|---|
| 📥 | **CONTRACT-1** | Full pass over agent-facing language — every tool description, `get_project_info`, `list |
| 📥 | **ENV-1** | Staging environment — an online copy of the platform to debug against (operator, 2026-07 |
| 📥 | **MT-2** | Org-scope the admin view, and/or fix the `get_project_info` "hand the admin URL to the c |
| 📥 | **OPS-2** | Breaking-change comms: platform behavior changes shipped under live sites with zero noti |
| 🚧 | **PLUG-2** | Base/blueprint composition model — now a full plan: [plans/PLUGIN-BASES-PLAN.md](plans/P |
| 📥 | **QRY-3** | Publish the limits in the contract: per-IP rate budget, `429` + `retry-after`, size caps |
| 🗓️ | **QRY-5** | Reporting: date-bucketed aggregates (`granularity: day\ |
| 📥 | **SEC-1** | Masked / write-only field type — today any credential in a normal field is plaintext in  |
| 📥 | **WP-3** | Fix the hooks×bulk contract contradiction: `define_collection.hooks` says bulk is "refus |
| 📥 | **WP-7** | Bulk write + delete on the delivery API. Bulk ops are MCP-only, so a delivery-side clien |

_…plus 34 at M/L priority._
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
