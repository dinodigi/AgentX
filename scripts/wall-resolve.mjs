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
};

const stamp = (r) =>
  `\n\n---\n**${r.disposition}** 2026-07-28 · \`${r.ref}\`\n\n${r.note}`;

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
