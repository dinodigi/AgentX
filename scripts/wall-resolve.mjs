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
