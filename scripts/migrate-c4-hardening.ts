/**
 * C4 migration — DB-level hardening from the security pass.
 *
 * One free sandbox per workspace was enforced only by a raceable
 * count-then-insert check; this makes the DB the gate. Reports (and refuses
 * on) existing violations rather than guessing which duplicate to keep.
 *
 * Run:  npx tsx scripts/migrate-c4-hardening.ts
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const dupes = (await sql`
    SELECT workspace_id, count(*)::int AS n FROM projects
    WHERE plan = 'sandbox' AND workspace_id IS NOT NULL
    GROUP BY workspace_id HAVING count(*) > 1`) as { workspace_id: string; n: number }[];
  if (dupes.length > 0) {
    console.error("❌ Cannot install the one-sandbox index — these workspaces already hold multiples:");
    for (const d of dupes) console.error(`   workspace ${d.workspace_id}: ${d.n} sandboxes`);
    console.error("Resolve by upgrading/deleting extras, then re-run.");
    process.exit(1);
  }

  console.log("Applying DDL …");
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS projects_one_sandbox_per_ws_idx
    ON projects (workspace_id) WHERE plan = 'sandbox'`;

  console.log("\n✅ C4 hardening applied — one sandbox per workspace is now DB-enforced");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
