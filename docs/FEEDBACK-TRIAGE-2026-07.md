# Feedback Triage — July 2026 (first agent-sourced batch)

The CSLP project's agent filed **19 items** via `send_feedback` while building the Countryside CRM. All live on the console feedback wall (`/admin/console/feedback`). This is the triage — themes, severity, and disposition. It's the same signal class as the Stallion field report that drove v2.

## Fixed already
- 🔴 **SECURITY — MCP token accepted on /v1/* delivery** → FIXED (b1000e6). `resolveProjectId` now enforces delivery scope; MCP token on delivery = 401. Verified live.

## High-value themes (a v3 candidate set)

**A. Migration / import (blocks the Countryside 3.1k Salesforce import — the plugin's own headline)**
- `bulk_create_entries` 100/call → chatty (31 calls for 3.1k). Want a bigger/streaming import.
- Workflow **initial-state has no import escape hatch** — historical leads can't load at their real statuses (kit/converted/…); forces a drop-workflow→import→re-add dance. Want `{allowExplicitWorkflowState:true, confirm:true}`, audit-logged.
- `export_entries` caps at 5000 with a truncated flag, no cursor → backup becomes sampling. Want the `nextCursor` contract `query_entries` already has.

**B. Reporting (aggregate_entries)**
- `groupBy` only enum/relation → **"leads by rep" is impossible because owner is text** — and the plugin's own guidance advertises that recipe. (Self-inflicted; see D.)
- No date bucketing (`granularity: day|week|month`) and no 2nd groupBy dimension → by-month pipeline, volume-by-rep-by-month fall to client-side. ~90% of the plugin's advertised reports need this.

**C. Automation / workflow**
- `define_schedule` is actions-only (webhook/email) → **the recycle sweep can't self-host** and depends on an external agent being alive. Want a constrained declarative bulk-transition rule (cron + where + transition + stampField).
- 🟠 **Redefine silently DROPS a workflow** if `workflow` is omitted — a forgotten resend destroys live business rules with no warning. Dropped FIELDS need `confirm:true`; a dropped WORKFLOW should too. (Contained fix, high value.)
- Workflow `actors:['admin']` includes client-role members → no per-role transition gating; want claim-matching actors like access rules already support.
- Enum **option renames** have no mapped migration (renames[] is fields-only) → renaming a stage orphans stored values. Want `optionRenames:[{field,from,to}]` with backfill.

**D. Countryside plugin defects (our own def — fix these)**
- `owner` is `text` but guidance says "leads-by-rep = groupBy owner" → contradiction. Fix: model owner as a **relation to a `reps` collection** (makes the recipe work + unlocks groupBy).
- Baseline ships **no `searchable` fields** → delivery `?q=` dead on arrival. Ship `searchable:true` on leads name/email/phone.

**E. Bugs (contained)**
- `create_entry` rejects explicit `null` for optional fields while `update_entry` treats null as unset → asymmetric, breaks JSON clients doing `{x: v || null}`.
- **Stale schema read after write**: a just-created collection is briefly invisible to `list_collections` + relation validation → the next `define_collection` with a relation to it fails E_INTERNAL until retried (hit 3× applying countryside on a fresh project). Same read-after-write class we've fought elsewhere.

**F. Connectors**
- No **SMS/Twilio** connector, though the baseline ships `text_opt_in` — a consent flag with nothing to act on. Want `{type:'sms', to:'{{phone}}'}` event actions gated on `text_opt_in`.

**G. DX / docs (cheap)**
- MCP-path error hints use delivery wording ("sign in with the required role" is meaningless when authoring). Surface-aware hints.
- 404-for-unauthorized on access-ruled GETs is intentional anti-enumeration → document it.
- publicWrite "anonymous" actually needs the project (delivery) token → document the token requirement + embedding/rotation.
- `ne` never matching unset is correct but surprising; the `anyOf:[{ne},{exists:false}]` idiom is needed constantly → prominent docs callout or a first-class `neOrUnset`.

## Backlog (user-requested, 2nd priority — NOT now)
- **Client-facing feedback plugin**: a plugin/tool so a CLIENT can collect end-user feedback for THEIR OWN project (their own wall), mirroring what we built for ourselves. For now `send_feedback` + the console wall is Pluggie-internal only. Revisit after the internal loop is proven.

## Suggested next moves
1. **Track D (plugin defects)** — smallest, and the plugin currently ships a self-contradiction. (owner→relation, searchable fields.)
2. **Track C redefine-drops-workflow confirm gate** — a silent data-rule destroyer, contained fix.
3. **Track A import escape hatch** — unblocks the real 3.1k migration this client needs.
Then B (reporting) and F (SMS) as the client engagement demands.
