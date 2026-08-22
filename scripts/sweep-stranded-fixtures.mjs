/**
 * One-off: remove smoke-test fixture projects stranded in the CONTROL DB.
 *
 * These are throwaway projects the test suite creates per test file. The suite
 * deletes its own, and a sweeper in scripts/smoke/helpers.mjs clears any left by
 * a crash — but that sweeper only runs DURING a smoke run, and smoke moved to a
 * separate test database shortly after these were made. So they are orphans that
 * nothing will ever come back for.
 *
 * Guards, all of which must hold for EVERY row or the script aborts without
 * deleting anything:
 *   · name matches the exact minted fixture shape
 *   · plan IS NULL          (a real project has a plan)
 *   · workspace_id IS NULL  (a real project belongs to someone)
 *   · older than 7 days     (never touch a concurrently running suite)
 *
 * platform_feedback.project_id is ON DELETE SET NULL, so feedback SURVIVES with
 * a blank project rather than being destroyed alongside the fixture.
 *
 *   node --env-file=.env scripts/sweep-stranded-fixtures.mjs          # dry run
 *   node --env-file=.env scripts/sweep-stranded-fixtures.mjs --apply
 */
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const apply = process.argv.includes("--apply");

const PATTERN = "^smoke [a-z0-9-]+ [0-9]{13}$";

const before = await sql`SELECT count(*)::int n FROM projects`;
const targets = await sql`
  SELECT id, name, plan, workspace_id, created_at
  FROM projects
  WHERE name ~ ${PATTERN} AND plan IS NULL AND workspace_id IS NULL
    AND created_at < now() - interval '7 days'`;

console.log(`projects before: ${before[0].n}`);
console.log(`fixtures matching every guard: ${targets.length}`);

// Refuse to run if anything that matched the NAME fails another guard — that
// would mean the pattern is catching something it should not.
const looseMatch = await sql`SELECT count(*)::int n FROM projects WHERE name ~ ${PATTERN}`;
if (looseMatch[0].n !== targets.length) {
  console.error(
    `ABORT: ${looseMatch[0].n} projects match the name pattern but only ${targets.length} pass every guard. ` +
      `Something named like a fixture has a plan, a workspace, or is recent. Inspect before deleting.`,
  );
  process.exit(1);
}

const ids = targets.map((t) => t.id);
if (ids.length === 0) {
  console.log("nothing to sweep.");
  process.exit(0);
}

const [cols] = await sql`SELECT count(*)::int n FROM collections WHERE project_id = ANY(${ids})`;
const [entries] = await sql`SELECT count(*)::int n FROM entries WHERE project_id = ANY(${ids})`;
const [toks] = await sql`SELECT count(*)::int n FROM project_tokens WHERE project_id = ANY(${ids})`;
const [fb] = await sql`SELECT count(*)::int n FROM platform_feedback WHERE project_id = ANY(${ids})`;
const [recent] = await sql`
  SELECT count(*)::int n FROM project_tokens
  WHERE project_id = ANY(${ids}) AND last_used_at > now() - interval '7 days'`;

console.log(`  cascades to: ${cols.n} collections, ${entries.n} entries, ${toks.n} tokens`);
console.log(`  feedback rows pointing at them: ${fb.n}  (FK is SET NULL — these survive)`);
console.log(`  tokens used in the last 7 days: ${recent.n}`);

if (recent.n > 0) {
  console.error("ABORT: a fixture token was used recently. Something is still talking to one of these.");
  process.exit(1);
}

if (!apply) {
  console.log("\nDRY RUN — re-run with --apply to delete.");
  process.exit(0);
}

const fbBefore = await sql`SELECT count(*)::int n FROM platform_feedback`;
const gone = await sql`DELETE FROM projects WHERE id = ANY(${ids}) RETURNING id`;
const after = await sql`SELECT count(*)::int n FROM projects`;
const fbAfter = await sql`SELECT count(*)::int n FROM platform_feedback`;
const orphaned = await sql`SELECT count(*)::int n FROM platform_feedback WHERE project_id IS NULL`;

console.log(`\ndeleted ${gone.length} fixture projects`);
console.log(`projects: ${before[0].n} -> ${after[0].n}`);
console.log(`feedback: ${fbBefore[0].n} -> ${fbAfter[0].n}  (${orphaned[0].n} now have no project, as designed)`);
if (fbAfter[0].n !== fbBefore[0].n) {
  console.error("WARNING: feedback rows were lost — the FK did not behave as SET NULL.");
  process.exit(1);
}
console.log("feedback intact ✓");
