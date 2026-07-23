/**
 * D1 migration batch (friction sprint) — hand-applied because `db:push` is
 * broken against Neon PG18. Idempotent; run against BOTH databases:
 *
 *   npx tsx --conditions react-server --env-file=.env scripts/migrate-token-expiry-batch.ts        # prod
 *   npx tsx --conditions react-server --env-file=.env --env-file=.env.test scripts/migrate-token-expiry-batch.ts  # test
 *
 * Three columns, one pass (the "batch the hand-applied migrations" rule):
 *
 * 1. project_tokens.expires_at (timestamptz NULL) — OAuth prerequisite. NULL =
 *    legacy non-expiring token (every existing row), so nothing breaks on
 *    deploy; enforcement in resolveToken treats NULL as no-expiry. DX-6's
 *    consent-issued tokens will set it; long-lived tokens become a choice,
 *    not the only option.
 * 2. project_tokens partial index on expiry — the resolver's hot path filters
 *    live tokens; an expired-token sweep (later) walks the same index.
 * 3. project_plugins.realized_names (jsonb NULL) — PLUG-4: the collections a
 *    plugin's apply ACTUALLY produced, stamped at apply time. Turns PLUG-3's
 *    evidence-not-verdict applied-state into ground truth wherever the stamp
 *    exists; NULL rows keep today's name-matching heuristic.
 *
 * NOT here on purpose: OAuth grant/refresh-token tables. Their shape depends
 * on D2's scope vocabulary — designing storage before the vocabulary is how
 * schemas rot. They arrive with D3, as their own migration.
 */
import { sql } from "drizzle-orm";
import { controlDb } from "@/db";

function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const [row] = rowsOf<{ exists: boolean }>(
    await controlDb.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = ${table} AND column_name = ${column}
      ) AS exists`),
  );
  return Boolean(row?.exists);
}

async function main() {
  if (await hasColumn("project_tokens", "expires_at")) {
    console.log("project_tokens.expires_at already present");
  } else {
    await controlDb.execute(sql`ALTER TABLE project_tokens ADD COLUMN expires_at timestamptz`);
    console.log("added project_tokens.expires_at (NULL = non-expiring legacy)");
  }

  await controlDb.execute(sql`
    CREATE INDEX IF NOT EXISTS project_tokens_expiry_idx
      ON project_tokens (expires_at) WHERE expires_at IS NOT NULL`);
  console.log("ensured partial index project_tokens_expiry_idx");

  if (await hasColumn("project_plugins", "realized_names")) {
    console.log("project_plugins.realized_names already present");
  } else {
    await controlDb.execute(sql`ALTER TABLE project_plugins ADD COLUMN realized_names jsonb`);
    console.log("added project_plugins.realized_names (PLUG-4 ground-truth stamp)");
  }

  const [tok] = rowsOf<{ n: number }>(
    await controlDb.execute(sql`SELECT count(*)::int AS n FROM project_tokens WHERE expires_at IS NOT NULL`),
  );
  console.log(`verified: ${tok?.n ?? 0} tokens carry an expiry (expected 0 until DX-6 issues them)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
