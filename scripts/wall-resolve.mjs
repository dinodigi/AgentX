#!/usr/bin/env node
/**
 * wall-resolve — close feedback-wall items with a RECEIPT the reporter can read.
 *
 * The burn-down protocol (docs/pm/BURNDOWN.md) says an item is closed when it
 * has an ANSWER, not only when it has been built. That only works if the answer
 * is written where the reporter sees it — otherwise a declined item comes back
 * as a fresh report in six weeks and we pay for it twice.
 *
 * So closing appends a structured receipt block to `detail` (which the console
 * renders) rather than silently flipping `status`.
 *
 * Usage:  node --env-file=.env scripts/wall-resolve.mjs
 *         node --env-file=.env scripts/wall-resolve.mjs --apply
 *
 * Dry-run by default. Edit RESOLUTIONS below, check the diff, then --apply.
 */
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const apply = process.argv.includes("--apply");

/**
 * id prefix -> { disposition, ref, note }
 *   disposition: SHIPPED | ANSWERED | DECLINED | TRIGGER
 *   ref:         commit hash, or the trigger condition
 */
const RESOLUTIONS = {
  // --- A1: the workflow actor vocabulary split (commit 2798606) -------------
  a61039c4: {
    disposition: "SHIPPED",
    ref: "2798606",
    note:
      "You were right, and a second tester hit the same thing 8 days later. " +
      "The actor vocabulary is now split: `operator` (workspace members and " +
      "platform operators — real staff) and `client` (invited project members). " +
      "`admin` is KEPT as a deprecated alias meaning either, so every existing " +
      "workflow behaves identically on deploy — that is asserted by test, not " +
      "assumed. The asymmetry is deliberate: `admin` accepts operator+client, " +
      "but `operator` does NOT accept a bare `admin`, so a staff-only gate is " +
      "now genuinely staff-only. The audit trail also carries the role, so it " +
      "can finally answer 'was that staff?' about writes already made.",
  },
  "75f9f4f7": {
    disposition: "SHIPPED",
    ref: "2798606",
    note:
      "Agreed — a parenthetical NOTE was the wrong home for an authorization " +
      "boundary, and you were the second person to say so independently. There " +
      "is now a real `operator` actor distinct from `client`, `admin` survives " +
      "as a deprecated permissive alias so nothing breaks on deploy, and the " +
      "tool description carries the warning in capitals rather than in passing.",
  },

  // --- A2: convergence honesty on entry writes (commit 66ad28e) -------------
  e9628701: {
    disposition: "SHIPPED",
    ref: "66ad28e",
    note:
      "`create_entry` / `update_entry` / `delete_entry` now return a " +
      "`convergence` note. It names BOTH halves, because the second is the one " +
      "nobody expects: the ~15s timing gap, AND the visibility gap — the " +
      "delivery API applies publicFilter/access rules that MCP reads do not, so " +
      "a row can be readable over MCP yet PERMANENTLY absent from delivery. " +
      "Measuring a lower cache TTL is still open and tracked separately.",
  },
  "9c61bc7a": {
    disposition: "SHIPPED",
    ref: "66ad28e",
    note:
      "Exactly the gap you identified: `define_collection` explained itself and " +
      "entry writes said nothing, so the delay read as a bug. All three entry " +
      "mutations now return a `convergence` note covering the ~15s window and " +
      "the publicFilter asymmetry. Kept to one line deliberately — it rides " +
      "every write, so verbosity is a real token cost during bulk work.",
  },

  // --- A4: document the stateless transport (commit 66ad28e) ----------------
  "95b660d1": {
    disposition: "SHIPPED",
    ref: "66ad28e",
    note:
      "Documented — you were the second of THREE people who discovered this by " +
      "probing. `get_project_info` now carries `deliveryApi.statelessTransport`: " +
      "no initialize handshake, no session id, the exact JSON-RPC shape, where " +
      "results and errors live, and the rate limit. A test asserts the claim is " +
      "TRUE (a first-contact tools/call actually succeeds), because documenting " +
      "something false would be worse than documenting nothing.",
  },
  "74e7016d": {
    disposition: "SHIPPED",
    ref: "66ad28e",
    note:
      "Confirmed and now documented as supported rather than left to be " +
      "discovered. Three testers independently found it by probing and each " +
      "called it an integration advantage; one skipped the MCP SDK entirely and " +
      "wrote a 40-line fetch client. `get_project_info` now spells out the " +
      "stateless contract, and a test holds it honest.",
  },

  // --- CP2: the Track B papercuts (commit 0dbf3ff) --------------------------
  d128f35a: {
    disposition: 'SHIPPED', ref: '0dbf3ff',
    note:
      "bulk_create_entries now accepts create_entry's {collection, data:{...}} wrapper and " +
      'unwraps it per item, so carrying the sibling shape across works instead of failing all 14. ' +
      'It is only unwrapped when UNAMBIGUOUS — an item whose keys are all wrapper keys, and never ' +
      'for a collection that has its own field called "data", because silently discarding a real ' +
      'payload would be worse than the error we removed. The tool description now states the ' +
      'expected shape up front rather than leaving it to be inferred.',
  },
  ad690ade: {
    disposition: 'SHIPPED', ref: '0dbf3ff',
    note:
      'Optional relation/asset (and every other optional) sub-field inside a typed block or group ' +
      'now treats explicit null as absent, so an editor emitting null for "nothing selected" just ' +
      'works. Inside a block element null can only mean "nothing here" — the value is replaced ' +
      'wholesale, so there is no explicit-unset semantic to collide with, unlike a top-level field ' +
      'on a partial update where null still means unset. REQUIRED sub-fields still reject null: ' +
      'that is a real error, not a papercut.',
  },
  '4fae3449': {
    disposition: 'SHIPPED', ref: '0dbf3ff',
    note:
      'The entry id is now a filterable virtual field, so where:[{field:"id",op:"in",value:[...]}] fetches ' +
      'a known set in ONE call instead of N. eq/ne/in only — "contains" on a uuid is a substring ' +
      'scan that looks like it works, and "exists" is meaningless on a primary key. A collection ' +
      'that defines its own "id" field still wins, so nothing can be shadowed, and the ' +
      '"unknown field" error now lists id among the valid ones.',
  },
  '5e8146d8': {
    disposition: 'ANSWERED', ref: '0dbf3ff',
    note:
      'VERDICT CORRECTION, and thank you — the fix is real but the diagnosis was not. We could not ' +
      'reproduce the MCP half: writableBy is enforced ONLY on the delivery path, because an MCP ' +
      'token is an authoring credential that never reaches that gate. So the wording was already ' +
      'correct for its one surface. Your underlying point held anyway: "sign in with the required ' +
      'role" named something that does not exist — the gate is a CLAIM match, not a role. The ' +
      'message now says, per field, whether it is permanently server-only or which claim it needs.',
  },
  '1a24b96b': {
    disposition: 'SHIPPED', ref: '0dbf3ff',
    note:
      'increment now takes startingFrom: {field:"views",by:1,startingFrom:0} sets views=1 on the ' +
      'first call with no seed. You were right that this mattered beyond ergonomics — the ' +
      'seed-then-increment workaround races, and two callers can both observe "unset", both seed, ' +
      'and silently lose one count. A test fires ten concurrent first-increments and demands ' +
      'exactly 10. A bounds failure on a first increment is also no longer misreported as ' +
      '"field is not set", which used to send you straight back to seeding.',
  },
  '4847bc14': {
    disposition: 'SHIPPED', ref: '0dbf3ff',
    note:
      'You suggested a first-class op or a docs callout; you get the op. "neOrUnset" means ' +
      '"different OR not set" — {field:"email_opt_out",op:"neOrUnset",value:true} is the whole ' +
      'compliance filter. It earned code rather than documentation precisely because of your use ' +
      'case: forgetting the second clause of the anyOf idiom silently INCLUDES rows you must ' +
      'exclude, which is a wrong answer that looks like a working query. "ne" keeps its ' +
      'fail-closed meaning, which publicFilter depends on. SQL and the in-memory matcher are ' +
      'tested against each other, since a divergence would match in lists but fail single-entry gates.',
  },

  // --- CP3: the two open bugs (commit 65fa439) -----------------------------
  "58aaca1e": {
    disposition: "SHIPPED",
    ref: "65fa439",
    note:
      "You were right, and the evidence you supplied is what proved it — upload_asset succeeding " +
      "while the badge said error was the whole case. Root cause was not a broken probe but a " +
      "category error: the health check persists a POINT-IN-TIME probe as durable state, and a " +
      "probe that THREW (DNS, timeout, egress blip) wrote 'error' permanently until someone " +
      "re-tested. Your timeline confirms it: those connectors were created 01:11-01:16, you filed " +
      "at 01:42, and they were not touched again until 03:26 — which is when they went green. The " +
      "three that failed are exactly the three whose probes make OUTBOUND HTTP calls; neon, a " +
      "direct DB connection, was unaffected. Two fixes: a probe that fails to RUN no longer " +
      "overwrites the stored verdict (an unknown must not replace a known-good), and health now " +
      "carries checkedAt, so the notice reads 'FAILED ITS LAST CHECK 3h ago — may be working now' " +
      "instead of asserting a live fault we never observed.",
  },
  "921f9ec7": {
    disposition: "SHIPPED",
    ref: "65fa439",
    note:
      "You asked whether the generator or the docs was wrong. It was the GENERATOR. gateMutate " +
      "allows PATCH/DELETE for 'owner' OR any matching claim rule (staff write on any row), and " +
      "access.write may be a LIST — but the generator tested write === 'owner', which matched " +
      "neither a lone claim rule nor ['owner', {claim}]. The endpoints existed and worked the " +
      "whole time; the typed client simply denied they did. canMutate is now derived through the " +
      "gate's OWN helpers so the two cannot drift apart again, and a test confirms the PATCH route " +
      "really exists (a gate refusal, never a 405) so we have not taught the client to lie in the " +
      "other direction.",
  },

  // --- CP4/A3: indexed date fields (commit 2dfa814) -------------------------
  "0a5ce08c": {
    disposition: "SHIPPED",
    ref: "2dfa814",
    note:
      "Supported now — and you were right that the suggested workaround had no substitute. " +
      "The old rejection was technically correct and wrongly concluded: Postgres does refuse a " +
      "::timestamptz expression index (STABLE cast), but it refuses ::timestamp too, and the raw " +
      "TEXT it does allow turns out to be exact rather than approximate. Every date write is " +
      "stored as a fixed-width canonical UTC ISO string, and fixed-width ISO sorts " +
      "lexicographically exactly as it sorts chronologically. An EXPLAIN test asserts the planner " +
      "really uses it — index scan, range as an Index Cond, and no separate sort step — because " +
      "otherwise `indexed: true` would be a lie that looks like a feature. Existing values are " +
      "canonicalized to UTC when the index is added, so rows imported in another offset sort " +
      "correctly too.",
  },
  "34acd74d": {
    disposition: "SHIPPED",
    ref: "2dfa814",
    note:
      "Shipped — you and a second reporter six days apart made the same case, that published_at " +
      "is the canonical sort key for content and starts_at/ends_at the canonical scheduling " +
      "filter, so there was nothing else to index instead. `indexed: true` now works on date " +
      "fields. The index is on the raw text rather than a cast (Postgres refuses BOTH " +
      "::timestamptz and ::timestamp in an index expression), which is exact because writes store " +
      "fixed-width canonical UTC ISO — text order and chronological order are the same order. " +
      "Filtering and sorting both use it; a test asserts the plan, not just the index's existence.",
  },

  // --- CP5/A5: publicWrite composes with access.write (commit 8d63719) ------
  e0b6eb32: {
    disposition: "SHIPPED",
    ref: "8d63719",
    note:
      "They compose now. publicWrite governs the ANONYMOUS POST; access.write governs PATCH/DELETE " +
      "— so the anonymous-intake / claim-gated-triage desk is ONE collection, no split needed. " +
      "gateMutate is untouched, so nothing became mutable that was not already. Two calls worth " +
      "flagging: a signed-in user who misses the claim may still POST, attributed to them (refusing " +
      "would be theatre — they can drop the token and post anonymously, which is strictly more " +
      "permissive), but an INVALID token still 401s, because a broken credential is not the same as " +
      "no credential. publicWrite still cannot combine with an owner or org scope: an anonymous row " +
      "has no verified identity, so it would be orphaned — invisible to owner-scoped reads and " +
      "unmutatable — and that is now refused at define time rather than stored silently.",
  },
  "16d745d3": {
    disposition: "SHIPPED",
    ref: "8d63719",
    note:
      "Your reading of the docs was right and the behavior was wrong. A tokenless POST returned 401 " +
      "because any non-none access.write REPLACED the anonymous path; it now COMPOSES with it, so " +
      "publicWrite means what it says while access.write gates PATCH/DELETE. The docs that " +
      "contradicted this moved with the code — both define_collection's description and the " +
      "accessNote returned at define time now spell out which half governs which verb, rather than " +
      "telling you the write rule wins.",
  },

  // --- CP6: schema mutation ergonomics (commit f5a99f7) ---------------------
  "9c2333cb": {
    disposition: "SHIPPED",
    ref: "f5a99f7",
    note:
      "define_collection now takes `addFields` — append without re-sending the whole shape. You " +
      "framed this as verbosity; it was worse than that, and thank you for the report, because " +
      "chasing it found a real lost update. Re-sending every field is a read-modify-write, so two " +
      "agents adding different fields race and the loser's field silently vanishes while BOTH " +
      "report success. A test with two concurrent adders reproduced it. Resolving against a fresh " +
      "read only narrowed the window, and verify-after-write did not help either (each racer can " +
      "verify before the other's write lands), so the WRITE itself now carries an " +
      "optimistic-concurrency guard: the upsert applies only if the collection has not changed, " +
      "and a conflict re-resolves and retries rather than overwriting. `fields` still means the " +
      "whole declarative shape, and mixing the two is refused rather than silently merged.",
  },
  "1c10d760": {
    disposition: "SHIPPED",
    ref: "f5a99f7",
    note:
      "Raised 100 → 500, so your 3.1k-lead import is 7 calls instead of ~31. Worth saying why it " +
      "was 100: that number was never the database's limit. Bulk creates are bounded by the " +
      "beforeCreate HOOK budget, and that has its own separately computed cap — so a collection " +
      "with no hook was paying a cost it does not incur. The new ceiling is asserted end-to-end " +
      "with a real 500-row batch rather than assumed, since a cap nobody exercises is a cap nobody " +
      "trusts. Collections WITH a beforeCreate hook are still capped by the consult budget, which " +
      "is the constraint that actually exists.",
  },

  // --- CP6 (3/3): enum option renames (commit 260e64b) ----------------------
  "73a14ef7": {
    disposition: "SHIPPED",
    ref: "260e64b",
    note:
      "You called it exactly: renames covered field names only, so an option change was a silent " +
      "data loss with no error anywhere. The rows kept the old value, the enum no longer permitted " +
      "it, and each affected row then failed validation on its NEXT save while matching a filter " +
      "on neither the old name nor the new one — the schema said one thing, the data said another, " +
      "and nothing complained. renames now also takes {field, from, to}, rewriting the VALUE in " +
      "place. Trash is migrated alongside live rows, or a restore would resurrect a value the " +
      "schema rejects. Validation is deliberately strict, because a typo here rewrites stored " +
      "data: the field must be an enum on both sides, `from` must be a current option, `to` must " +
      "be one in the new definition, and keeping `from` in the new options is refused as ambiguous " +
      "rather than guessed at. The schema diff also had to learn the difference, so a safe option " +
      "migration no longer reads as a destructive field drop.",
  },

  // --- CP7 (1/3): array membership filtering (commit 47ed83e) ---------------
  cbf4db8f: {
    disposition: "SHIPPED",
    ref: "47ed83e",
    note:
      'You called it "correct at 5 posts and wrong at 500", and that framing is why this went ' +
      "first: it is the only item on the wall that ships fine and breaks after a customer has " +
      "invested. There is now a `has` op — JSONB containment on arrays of scalars — on BOTH read " +
      "planes: {field:\"tags\",op:\"has\",value:\"rust\"} over MCP, and ?tags=rust on the delivery " +
      "API, which previously compiled to tags = 'rust' and could never match a JSON array. " +
      "Containment specifically, because that is the operator a GIN index can serve, and the value " +
      "is coerced to the item type so a numeric tag does not silently miss on JSON 1 !== \"1\". " +
      "You also spotted the deeper problem — the generated client's filter type advertised `tags` " +
      "the whole time. It typed the filter as the FIELD (unknown[]), so it could not even express " +
      "the query; filters now type as the ITEM. Two things came out of fixing it: arrays became " +
      "sortable-looking the moment they became filterable, and sorting one would have ordered rows " +
      "by raw JSONB — a meaningless answer presented as a real one — so that is now refused and " +
      "omitted from the client's sort union. Arrays of GROUPS remain unfilterable; structured " +
      "content is not a set.",
  },

  // --- CP7 (2/3): relative time in where clauses (commit 279d70e) -----------
  a1fb8001: {
    disposition: "SHIPPED",
    ref: "279d70e",
    note:
      "Shipped, and your instinct about what was missing was exactly right — define_schedule " +
      "already spoke {hoursAgo:n}, so this wires that SAME vocabulary to where clauses rather than " +
      "inventing a second spelling. publicFilter [{starts_at lt {hoursAgo:0}}, {ends_at gt " +
      "{hoursAgo:0}}] now serves a row only inside its window, database-enforced, with no sweep " +
      "and no gap between ticks. Negative reaches forward, so {hoursAgo:-24} is 24h out. " +
      "One thing worth flagging, because it would otherwise have reproduced your exact symptom in " +
      "a new place: a publicFilter using relative time is TIME-VARYING, and an edge-cached copy " +
      "would keep serving an expired row — at 60s instead of an hour, but the same class of wrong. " +
      "Those collections no longer set s-maxage, so an exact window costs you the CDN hit. That is " +
      "deliberate, and scoped to collections that asked for a window; everything else keeps its " +
      "edge cache. Your ad-inventory framing is what made that trade obvious.",
  },

  // --- CP7 (3/3): date buckets + second groupBy (commit 0ee45c9) -----------
  "2684fec0": {
    disposition: "SHIPPED",
    ref: "0ee45c9",
    note:
      "Both halves, and thank you for keeping this one on the list since 07-18. groupBy now takes " +
      'a bucketed date — {field:"created_at",bucket:"month"}, with day/week/quarter/year too — and ' +
      "an ARRAY of up to two dimensions for a cross-tab like source x stage, so the by-month " +
      "pipeline and the two-dimension report are both one call instead of fetching rows and " +
      "grouping client-side. Keys come back as compact sortable labels (2026-Q3, 2026-W31), not " +
      "raw timestamps, since they are report axis keys a human reads. " +
      "Two refusals came out of building it that matter more than the feature: a date with NO " +
      "bucket is now rejected, because it would not have errored — it would have made one group " +
      "per row, truncated at the group cap, and handed you a report that looks complete and is " +
      "built from an arbitrary slice. A third dimension is refused for the same reason. And " +
      "`key` still carries the first dimension with `keys` omitted entirely for a single " +
      "dimension, so nothing you already built against this tool changed shape.",
  },

  // --- CP8: capacity SHIPPED; two items closed as TRIGGER -------------------
  "8570cb24": {
    disposition: "SHIPPED",
    ref: "bea3377",
    note:
      "`capacity: N` on a field — at most N rows may share each value. You framed it exactly " +
      "right: unique gives exactly-one-per-key and nothing gave at-most-N. The important part is " +
      "WHERE it is enforced. A count-then-insert in application code cannot be made correct from " +
      "outside the database — two callers both count 9 of 10 and both insert — so this is a " +
      "trigger that takes a per-key advisory lock before counting. A test rushes a 3-seat slot " +
      "with 10 concurrent bookings and demands exactly 3 winners. Moving a row INTO a full key is " +
      "refused too, while updating a row already in a full key still works (it counts toward its " +
      "own slot; re-counting it would make a full slot permanently uneditable). Overflow arrives " +
      "as E_VALIDATION naming the full key, on the same error path as a unique violation.",
  },
  de626cb6: {
    disposition: "TRIGGER",
    ref: "a second project asks, or one client commits to SMS",
    note:
      "Not building this yet, and I would rather say so plainly than leave it sitting on the wall " +
      "looking planned. You are right that countryside_crm's baseline implies messaging, but an " +
      "SMS connector needs an operator-held Twilio account, a billing relationship, and per-country " +
      "compliance (sender IDs, opt-out handling) — that is a product decision with recurring cost, " +
      "not a missing adapter. REOPENS WHEN: a second project asks for SMS, or one client commits " +
      "to paying for it. Until then text_message steps in the baseline should be read as email or " +
      "webhook, and if you have a client waiting, say so and this moves immediately.",
  },
  "42a6d515": {
    disposition: "TRIGGER",
    ref: "after the wall is clear (plugin-authored tools, PLUG line)",
    note:
      "Accurate report, and the gap is real: plugins ship collections, workflows and schedules but " +
      "`tools: []` is inert, so anything bespoke gets re-implemented per project. Letting a plugin " +
      "contribute MCP tools is a design pass of its own, though — it decides who may execute what, " +
      "how a tenant-authored tool is sandboxed, and how versioning works when a project pins an " +
      "older plugin. Doing that carelessly is how a content platform grows a code-execution " +
      "surface. REOPENS WHEN: the feedback wall reaches zero, which is the current sprint's goal " +
      "and is close — this is first in line after it, tracked on the PLUG line in docs/BACKLOG.md.",
  },

  // --- delivery status codes (commit 43d0cd9) ------------------------------
  "2bdec2b0": {
    disposition: "ANSWERED",
    ref: "43d0cd9",
    note:
      "Reproduced, and the answer is the first of your two options — with a correction to the " +
      "premise. An access-ruled collection WITH publicRead fields already returns a clean 401 " +
      "naming X-User-Token; you were not seeing the auth gate. The 404 appears only when NO field " +
      "is publicRead, and an AUTHENTICATED caller gets the SAME 404 — which is what settles it. " +
      "The status is honest (there is nothing to serve to anyone, whoever asks), and 401 would be " +
      "a lie: it would send you to a door that does not open. " +
      "Your real complaint was right though — nothing said any of that, which is exactly how you " +
      "ended up chasing a routing bug. The 404 now states that it is NOT an auth failure, that " +
      "signing in will not change it, and that it is unrelated to any access rule; and " +
      "get_project_info carries a statusCodes guide (401/403/404/422/429) so the rule is " +
      "discoverable rather than reverse-engineered.",
  },

  // --- D3: browser-safe read-only delivery token (commit 57bbea4) ----------
  eff3e105: {
    disposition: "SHIPPED",
    ref: "57bbea4",
    note:
      "mint_delivery_token now takes readOnly:true, and that token is safe to embed in a browser " +
      "bundle — so the edge proxy whose only job was holding a credential can go. Your report is " +
      "what reframed this correctly: a read-only token grants EXACTLY what publicRead already " +
      "exposes to the anonymous internet, so if that data is public a leak leaks nothing new. The " +
      "real cost is abuse, which is rate-limiting and revocation, not authorization. " +
      "Writes are deliberately still excluded: a browser-embeddable write endpoint is a spam " +
      "surface in a way reads are not, and it deserves a human-verification story rather than " +
      "being bundled in quietly. Existing tokens are untouched (scopes = null still means full " +
      "access, asserted by test — that failure would have broken every deployed site at once), and " +
      "list_delivery_tokens now shows readOnly so a human can tell a browser-safe credential from " +
      "one that must never leave a server.",
  },
  "66d1cbd9": {
    disposition: "SHIPPED",
    ref: "57bbea4",
    note:
      "Shipped as a read-only delivery token class — mint_delivery_token with readOnly:true. It is " +
      "safe to embed in a client bundle because it can do exactly what publicRead already exposes " +
      "to anyone on the internet, and every write path (POST/PATCH/DELETE, uploads, checkout) " +
      "refuses it with E_SCOPE. Enforced at the single choke point where delivery tokens are " +
      "resolved, so there is no path that forgot. Browser-side WRITES are a deliberate follow-up " +
      "rather than an omission: public writes from a bundle need a human-verification story first.",
  },

  // --- D2: transition preconditions (commit 346cdd4) -----------------------
  "6809681c": {
    disposition: "SHIPPED",
    ref: "346cdd4",
    note:
      "Transitions now take a `when` precondition, using the same clause vocabulary as query " +
      "where: [{from:'draft',to:'live',when:[{field:'creative',op:'exists',value:true}]}]. Your " +
      "diagnosis was the useful part — the required-field workaround did not just feel clumsy, it " +
      "put the constraint at the wrong MOMENT, blocking every draft save to enforce a rule about " +
      "one transition. " +
      "It is compiled into the same conditional UPDATE as the state guard, on both the ordinary " +
      "and the CAS path, so a concurrent write cannot clear the required field between check and " +
      "write. Preconditions are kept PER BRANCH: two transitions reaching the same state can carry " +
      "different rules, and ANDing them would enforce something nobody wrote. A refusal names the " +
      "unmet requirement rather than reporting a conflict — the two need opposite responses, and " +
      "calling a precondition failure a race would send you into a retry loop that never succeeds.",
  },

  // --- D1: SEC-1 write-only fields + auth_kit v2 (4de9ddb, 4e4491f) --------
  // The LAST open item on the wall. Split disposition on purpose: the write-only
  // primitive shipped, platform-side verification did not, and saying so plainly
  // is the difference between a closed item and one that comes back in six weeks.
  "0ceec805": {
    disposition: "SHIPPED (in part) + TRIGGER",
    date: "2026-07-29",
    ref: "4de9ddb, 4e4491f",
    note:
      "The most thorough report on the wall, and it changed the design twice — thank you. " +
      "Two halves, and I want to be exact about which one shipped.\n\n" +
      "**SHIPPED — the write-only primitive you specified.** `{type:\"text\", writeOnly:true}` is " +
      "written and never returned by any read. You were right that masking the admin display would " +
      "not be sufficient, and right about which surfaces mattered: the field's NAME now never " +
      "appears as a key in a read payload — `get_changes`, `export_entries` (json rows AND the csv " +
      "COLUMN, because an empty column invites a re-import that fills it back in), " +
      "`list_entry_versions`, MCP projection, the delivery API, SSE, webhook and email payloads, " +
      "the delivery log, before-write hook envelopes, and the admin list and form. Absent rather " +
      "than masked, deliberately: a `***` marker is a value, and values get logged, diffed, cached " +
      "and eventually written back. Two layers, because either alone has a hole — the value is " +
      "never copied into version snapshots, feed rows or event payloads, AND every read redacts " +
      "anyway, since a field FLIPPED to write-only leaves plaintext in history that storage " +
      "stripping cannot reach backwards into. Filtering, sorting and selecting it are refused (an " +
      "eq/contains probe is a read with extra steps), as are `unique` and `capacity` (a conflict " +
      "would report that a value exists), nesting it in a group/array, deriving a computed field " +
      "FROM it, and using it as a relation labelField or an email token. `describe_collection` " +
      "still NAMES the field and flags it, so a schema stays explainable — hiding its existence " +
      "would leave an agent writing a password, reading the row back, seeing nothing, and " +
      "concluding the write failed.\n\n" +
      "**NOT SHIPPED — `verify_credential`, and here is the honest reason.** Working through your " +
      "proposal surfaced something that changes it: a write-only field cannot hold a password " +
      "hash. Verifying a hash means COMPARING it, and a comparison is a read; argon2id embeds a " +
      "random salt, so you cannot even recompute the hash to compare without first reading the " +
      "stored value. So the primitive you asked for does not by itself let Pluggie hold your " +
      "hashes — platform-side verification is required, and that is us becoming an identity " +
      "provider: we would own password reset, MFA and session revocation permanently. That is a " +
      "real product and the wrong sprint, so it is recorded as BACKLOG SEC-3 rather than " +
      "half-built. A hash we store and cannot verify would be strictly worse than one we never " +
      "held. TRIGGER: a second project independently asks for it, or a tenant ships a " +
      "demonstrably wrong implementation of the recipe below.\n\n" +
      "**SHIPPED INSTEAD — `auth_kit` v2 carries the rest of your five files.** Lockout is now " +
      "data, not advice: `users.failed_attempts` / `last_failed_at` / `locked_until` / " +
      "`password_changed_at` / `password_algo`, all `writableBy:'none'`, with the recipe " +
      "incrementing through `update_entry_if`'s ATOMIC increment (`startingFrom:0`, so the first " +
      "attempt is atomic too) — the read-then-write version most people write first silently " +
      "undercounts concurrent attempts, which is a bypass rather than a rounding error, and a test " +
      "fires five failures at once and asserts the count is five. A `password_resets` collection " +
      "makes single-use the WORKFLOW's guarantee (`used` is terminal, so there is no route back to " +
      "pending) with a server-stamped uuid token and `expires_at`. Your argon2id parameters " +
      "(m=19456, t=2, p=1) are the stated recipe, with rehash-on-login as the upgrade path and " +
      "`password_algo` so you can list accounts on outdated parameters by QUERY without reading a " +
      "hash — you called the upgrade path the real cost of owning this, and it was the part most " +
      "worth centralising. And the enumeration defence is written down WITH the trap you found: " +
      "the dummy must be a real argon2id hash, because a malformed one fails on parse and returns " +
      "instantly, reintroducing the exact timing signal it exists to remove. That detail is in the " +
      "plugin's guidance and in its acceptance list, so the next integrator gets it for free " +
      "instead of deriving it the way you had to.",
  },

  // --- XVibe wall batch 2026-07-30 ------------------------------------------
  "15e5783b": {
    disposition: "ANSWERED",
    date: "2026-07-30",
    ref: "d0a7f89",
    note:
      "Confirmed, and thank you for the precise citation — it let us find the root cause in " +
      "minutes. You were reading a SNAPSHOT COPY of the contract (the xvibe-brief docs), frozen " +
      "before the composition change shipped; the live platform and the live tool description " +
      "have said \"they COMPOSE, per verb\" since then. The fix is structural, not editorial: the " +
      "copy is DELETED, and the contract is now served by URL — GET /api/contract (markdown, or " +
      "?format=json for the verbatim tools/list payload) — rendered at request time from the same " +
      "TOOL_DEFS the MCP server answers with, so a stale copy of the contract can no longer " +
      "exist. get_project_info.urls.contract carries the link; point your system prompt at the " +
      "URL rather than pasting the text. A regression test now asserts the endpoint contains the " +
      "composed semantics and never again the phrase you quoted.",
  },
  "6e5af8cd": {
    disposition: "TRIGGER",
    date: "2026-07-30",
    ref: "a tenant asks for a SPECIFIC credential category (llm, sms, …)",
    note:
      "Split decision, and the split is the honest part. The BOUNDED version — per-category " +
      "adapters (an `llm` category holding an OpenAI-class key, invocable through a deliberate, " +
      "metered action, exactly like the email/payments adapters you cited) — is agreed and " +
      "recorded as backlog CONN-3, opening per category the moment a tenant asks for that " +
      "category (the SMS category is already queued the same way). The GENERIC half — store any " +
      "API credential and invoke any third-party API from the delivery surface — is DECLINED, " +
      "with the reason written down: that is an API gateway product (SSRF surface, egress " +
      "metering, credential liability), and the platform's answer for arbitrary server-side " +
      "calls from static apps is XVibe's bounded server-side phase, not a generic proxy. So: " +
      "name the specific integration you need next and it becomes the first adapter.",
  },

  // --- XVibe intake sprint CP-A (a0cfb72) -----------------------------------
  "2479b787": {
    disposition: "SHIPPED",
    date: "2026-07-30",
    ref: "a0cfb72",
    note:
      "Built, and your report argued for itself better than we could have: two of the four " +
      "examples on your hand-maintained list (capacity>1, time-bucketed aggregates) had ALREADY " +
      "shipped when you filed it — which is exactly the staleness this feature exists to end. " +
      "get_project_info.briefing.notSupported now serves the boundary registry: each entry is " +
      "{capability, status: not_supported|scheduled|declined, alternative, ref}, and every entry " +
      "tells your agent what to do INSTEAD today, not just where the wall is. Two disciplines keep " +
      "it from rotting the way your list did: it is deliberately SHORT, and a test parses our " +
      "backlog and FAILS THE BUILD if any cited item ships while still listed — shipping a listed " +
      "capability physically cannot leave the registry stale. Drop the hand-maintained list from " +
      "your system prompt and read the briefing instead; that was the point of your proposal, and " +
      "it was a good one.",
  },
  "21f4c5d5": {
    disposition: "SHIPPED",
    date: "2026-07-30",
    ref: "a0cfb72",
    note:
      "You called the naming misleading and you were right — publicRead means \"served by the " +
      "delivery API\", for EVERY reader including authenticated ones; access.read chooses WHO, " +
      "publicRead chooses WHICH fields. Renaming the flag would break every stored schema, so the " +
      "fix lands where the mistake is made instead: a define_collection with a gated read now " +
      "returns an accessNote stating the rule and NAMING the delivery-hidden fields (\"serves 1 of " +
      "3 fields — delivery-hidden: internal_notes, assignee\"), and the zero-public-fields case " +
      "says outright that the collection is not on the delivery API at all (404, " +
      "identity-independent). It is a note rather than a refusal because hidden fields on a gated " +
      "collection are often exactly what you want — but the semantics can no longer be misread " +
      "silently. The field-config contract copy now states it too.",
  },

  // --- XVibe intake sprint CP-B/C/D -----------------------------------------
  "0cd6dce5": {
    disposition: "SHIPPED",
    date: "2026-07-30",
    ref: "91edc77",
    note:
      "Built as transitions[].set, and your framing decided the design: the stamp lands IN THE SAME " +
      "UPDATE as the state move, on both write paths — update_entry, update_entry_if, and therefore " +
      "scheduled mutate-transitions, which ride the CAS path. Your exact case is the test's lead: " +
      'set: {"resolved_at": "now"} on a →resolved transition records transition time, not sweep ' +
      "time, with no second write for anyone to remember. Vocabulary is the schedule-mutate closed " +
      'set: "now" (date fields), {value: literal} (define-time validated), null (unset; refused on ' +
      "required fields). Per-branch like the `when` preconditions — two transitions into the same " +
      "state stamp independently — and a stamp OVERRIDES the caller's same-key patch value, because " +
      "the machine's record of the move beats a client's claim about it.",
  },
  "61f9b82e": {
    disposition: "SHIPPED",
    date: "2026-07-30",
    ref: "6992092",
    note:
      "Built. define_collection now takes dryRun:true and returns the FULL plan — the complete diff " +
      "(added/removed/retyped, renames, locale toggles), constraint-tightening warnings, the access " +
      "coaching notes, and whether the real call would demand confirm — with nothing applied; new " +
      "collections report wouldCreate, and addFields composes so you can preview an append. One " +
      "planner, two exits: a test asserts the dry diff EQUALS the destructive-confirm plan for the " +
      "same proposal, because a preview that disagreed with the gate would be worse than none. " +
      "Your plan-mode loop is now: propose with dryRun, show the diff, re-send without it.",
  },
  ad7568ba: {
    disposition: "SHIPPED",
    date: "2026-07-30",
    ref: "60d4c59",
    note:
      "Built as reset_project — and your E_BLOCKED ordering pain is the test's opening fixture. " +
      "Without confirm it returns the PLAN: exact counts of everything a wipe would remove " +
      "(collections, entries, trash, version history, the change feed, assets, blocks, schedules, " +
      "jobs, plugin enables, locales, inbound, the delivery log) plus an explicit KEPT list — " +
      "tokens (revoking your own credential mid-call is a trap), connectors, the audit log, usage " +
      "counters, branding, your authored plugin defs. With confirm:true it is one call to a clean, " +
      "immediately-reusable slate; dependency ordering does not apply because everything goes. " +
      "Two honesty notes: trash does NOT survive a reset (it is a factory reset, not a soft " +
      "delete), and the change feed is wiped — synced clients must treat a reset as a full " +
      "resync. The wipe itself lands on the operator's platform trail with the counts. " +
      "schema.manage scope required, which is the scope your eval harness token should hold anyway.",
  },

  // --- CONTRACT-2 + the addFields carry-forward bug (sprint CP2, 2339e32) ----
  "89053b98": {
    disposition: "SHIPPED",
    ref: "2339e32",
    date: "2026-08-04",
    note:
      "Correct, and you found a real structural defect rather than a missing sentence. The field-config " +
      "vocabulary lived in list_field_types while define_collection — the tool you actually call to define " +
      "a field — only gestured at it. Verified before fixing: `computed` appeared in define_collection " +
      "exactly ONCE and only as an exclusion (\"not for unique/searchable/computed\"), so its vocabulary " +
      "was absent entirely; `enum:options[]` was a bare token with no shape; indexed/writableBy/writeOnly " +
      "got zero mentions. define_collection now carries the common knobs inline INCLUDING the full " +
      "computed vocabulary, with {fn:'now'} on a date field called out — your exact case. " +
      "The guard is derived rather than hand-written: a test parses COMMON_FIELD_CONFIG out of the source " +
      "and fails until define_collection names every knob in it, so an 11th knob breaks the build until " +
      "both surfaces carry it. Worth saying plainly: a language audit shipped days before your report and " +
      "missed this, because that audit diffed each description against BEHAVIOUR — and nothing " +
      "define_collection said was false. The defect was structural, which a behaviour diff cannot see. " +
      "Your report is what added the structural check.",
  },
  "c91e2872": {
    disposition: "SHIPPED",
    ref: "2339e32",
    date: "2026-08-04",
    note:
      "Reproduced, and worse than reported: addFields dropped `access`, `workflow`, `events`, `checkout`, " +
      "`hooks`, `publicWrite`, `publicFilter` AND `webhookUrl` — every non-field config block. Root cause: " +
      "define_collection is FULL-REPLACE, and the addFields path forwarded the CALLER's blocks, which on a " +
      "pure addFields call are all undefined — i.e. \"remove them\". So the one input whose entire promise " +
      "is 'leaving the rest untouched' was the only one that wiped everything but the fields. " +
      "addFields now carries the CURRENT stored config forward for any block you omit, while a block you " +
      "DO pass still wins, and an explicit null still removes (that distinction is guarded by its own " +
      "test — using ?? instead of an undefined check would have turned this silent-drop bug into a " +
      "silent-keep bug, which is harder to notice). " +
      "How it surfaced is worth knowing: a confirm gate shipped the same day for a different reason — " +
      "refusing a redefine that drops an `access` block via `fields` — and it converted your silent " +
      "corruption into a loud refusal. Your report and that gate arrived within hours of each other and " +
      "confirmed the same root cause from two directions.",
  },
};

const stamp = (r) =>
  `\n\n---\n**${r.disposition}** ${r.date ?? "2026-07-28"} · \`${r.ref}\`\n\n${r.note}`;

const rows = await sql`
  SELECT f.id, f.summary, f.detail, f.status, p.name AS proj
  FROM platform_feedback f JOIN projects p ON p.id = f.project_id
  WHERE f.status IN ('new','planned')`;

let n = 0;
for (const [prefix, r] of Object.entries(RESOLUTIONS)) {
  const row = rows.find((x) => x.id.startsWith(prefix));
  if (!row) {
    console.error(`\x1b[31m✗ ${prefix} — no OPEN row matches (already closed?)\x1b[0m`);
    continue;
  }
  if ((row.detail ?? "").includes("---\n**")) {
    console.error(`\x1b[33m~ ${prefix} — already carries a receipt, skipping\x1b[0m`);
    continue;
  }
  console.log(`\x1b[32m${apply ? "✓" : "would close"}\x1b[0m ${prefix} [${row.proj}] ${row.summary.slice(0, 64)}`);
  console.log(`    → ${r.disposition} ${r.ref}`);
  if (apply) {
    await sql`UPDATE platform_feedback
              SET status = 'done', detail = ${(row.detail ?? "") + stamp(r)}
              WHERE id = ${row.id}`;
  }
  n++;
}

console.log(`\n${apply ? "closed" : "would close"} ${n} item(s).`);
if (!apply) console.log("Re-run with --apply to write.");
