/**
 * B4 migration — platform_events (control-plane operator-action trail).
 *
 * db:push is broken against Neon PG18 for incremental changes, so this applies
 * the DDL by hand. All IF NOT EXISTS — safe to re-run. `projects.status` needs
 * no DDL (plain text column, no CHECK): 'suspended' is app-level.
 *
 * Run:  npx tsx scripts/migrate-platform-events.ts
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log("Applying DDL …");
  await sql`CREATE TABLE IF NOT EXISTS platform_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    project_name text NOT NULL,
    type text NOT NULL,
    actor_email text NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS platform_events_project_idx
    ON platform_events (project_id, created_at)`;

  const [{ n }] = (await sql`SELECT count(*)::int AS n FROM platform_events`) as { n: number }[];
  console.log(`\n✅ Migration complete — platform_events ready (${n} rows)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
