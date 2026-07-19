# Feedback Triage — July 2026 (first agent-sourced batch)

The CSLP project's agent filed **19 items** via `send_feedback` while building the Countryside CRM. All live on the console feedback wall (`/admin/console/feedback`). This is the triage — themes, severity, and disposition. It's the same signal class as the Stallion field report that drove v2.

## Fixed already
- 🔴 **SECURITY — MCP token accepted on /v1/* delivery** → FIXED (b1000e6). `resolveProjectId` now enforces delivery scope; MCP token on delivery = 401. Verified live.
- 🟠 **Redefine silently DROPS a workflow** (#11) → FIXED (6256c51). Omitting `workflow` now hits the destructive-change gate (`workflowRemoved`, needs `confirm:true`); resend to keep. Root cause was deeper — the gate read `current` from the CACHED `listCollections()`, so a redefine that lagged the cache looked like a fresh create and bypassed the gate entirely; `current` is now read FRESH.
- 🐛 **Stale schema read → relation E_INTERNAL** (#19) → FIXED (6256c51). A relation to a just-created collection now confirms a "missing" target against a FRESH read before erroring, and raises E_VALIDATION (fixable) with a fix-forward hint instead of opaque E_INTERNAL.
- 🐛 **create_entry rejects explicit `null` on optional fields** (#18) → FIXED (6256c51). Create now treats a top-level `null` as "not provided" (symmetric with update's unset); a null on a REQUIRED field surfaces the clear "required" error. Unblocks JSON clients doing `{x: v || null}`.
- 🟠 **Workflow import escape hatch** (#12) → SHIPPED (748d7f9). `create_entry`/`bulk_create_entries` accept `allowExplicitWorkflowState: true` — historical records load at their real states (any declared enum option, orphan states included); use is stamped into the audit actor (`explicitWorkflowState: true`, visible in get_audit_log). MCP authoring only; delivery/transact stay strict; the rejection error now teaches the flag. Unblocks the 3.1k Salesforce migration.
- 🐛 **export_entries 5k sampling trap** (#6) → FIXED (748d7f9). Keyset cursor (same contract as query_entries, stable (createdAt,id) order): walk `nextCursor` to null = complete exact export; `truncated` kept as back-compat alias. Console download now walks the cursor server-side (whole collection).
- All five marked **done** on the wall.

## High-value themes (a v3 candidate set)

**A. Migration / import (blocks the Countryside 3.1k Salesforce import — the plugin's own headline)**
- `bulk_create_entries` 100/call → chatty (31 calls for 3.1k). Want a bigger/streaming import. *(Only A-item left.)*
- ✅ ~~Workflow **initial-state has no import escape hatch**~~ → **SHIPPED (748d7f9)**, see "Fixed already".
- ✅ ~~`export_entries` caps at 5000 with a truncated flag, no cursor~~ → **FIXED (748d7f9)**, see "Fixed already".

**B. Reporting (aggregate_entries)**
- `groupBy` only enum/relation → **"leads by rep" is impossible because owner is text** — and the plugin's own guidance advertises that recipe. (Self-inflicted; see D.)
- No date bucketing (`granularity: day|week|month`) and no 2nd groupBy dimension → by-month pipeline, volume-by-rep-by-month fall to client-side. ~90% of the plugin's advertised reports need this.

**C. Automation / workflow**
- `define_schedule` is actions-only (webhook/email) → **the recycle sweep can't self-host** and depends on an external agent being alive. Want a constrained declarative bulk-transition rule (cron + where + transition + stampField).
- ✅ ~~**Redefine silently DROPS a workflow** if `workflow` is omitted~~ → **FIXED (6256c51)**, see "Fixed already".
- Workflow `actors:['admin']` includes client-role members → no per-role transition gating; want claim-matching actors like access rules already support.
- Enum **option renames** have no mapped migration (renames[] is fields-only) → renaming a stage orphans stored values. Want `optionRenames:[{field,from,to}]` with backfill.

**D. Countryside plugin defects (our own def — fix these)**
- `owner` is `text` but guidance says "leads-by-rep = groupBy owner" → contradiction. Fix: model owner as a **relation to a `reps` collection** (makes the recipe work + unlocks groupBy).
- Baseline ships **no `searchable` fields** → delivery `?q=` dead on arrival. Ship `searchable:true` on leads name/email/phone.

**E. Bugs (contained)** — ✅ both FIXED (6256c51), see "Fixed already".
- ✅ ~~`create_entry` rejects explicit `null` for optional fields~~ → symmetric with update now.
- ✅ ~~**Stale schema read after write**~~ → fresh-read fallback + E_VALIDATION.

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
Done so far: the SECURITY fix, all of Track D (plugin defects), Track E (both contained bugs), Track C's redefine-drops-workflow gate (#11), and the migration pair — Track A's import escape hatch (#12) + export cursor (#6). What's left, in order:
1. **Track B reporting** — date bucketing + 2nd groupBy dimension; ~90% of the plugin's advertised reports need it.
2. **Track C** — `define_schedule` declarative bulk-transition (recycle sweep self-hosts) + per-role workflow actors + enum-option renames.
3. **Track A residue** — bulk-import batch size (100/call → chatty), when the real migration runs.
Then F (SMS) and the G docs/DX items as the client engagement demands.
