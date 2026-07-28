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
