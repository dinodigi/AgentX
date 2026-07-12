/**
 * C2 migration — rate_windows (durable rate-limit counters) + usage_daily
 * (per-project request metering rollup).
 *
 * db:push is broken against Neon PG18 for incremental changes, so this applies
 * the DDL by hand. All IF NOT EXISTS — safe to re-run.
 *
 * Run:  npx tsx scripts/migrate-usage-counters.ts
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  console.log("Applying DDL …");
  await sql`CREATE TABLE IF NOT EXISTS rate_windows (
    key text NOT NULL,
    window_start timestamptz NOT NULL,
    project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
    count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS rate_windows_start_idx
    ON rate_windows (window_start)`;
  await sql`CREATE TABLE IF NOT EXISTS usage_daily (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    day date NOT NULL,
    count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, day)
  )`;

  const [{ n: rw }] = (await sql`SELECT count(*)::int AS n FROM rate_windows`) as { n: number }[];
  const [{ n: ud }] = (await sql`SELECT count(*)::int AS n FROM usage_daily`) as { n: number }[];
  console.log(`\n✅ Migration complete — rate_windows (${rw} rows), usage_daily (${ud} rows)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
