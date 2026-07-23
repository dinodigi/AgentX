/**
 * TOK-1 migration — token parentage + cascade revoke.
 *
 * Adds `project_tokens.minted_by_token_id`, a self-reference with
 * ON DELETE CASCADE. This is what makes agent-minted delivery tokens safe:
 * revoking a token deletes everything it minted, as a database guarantee
 * rather than app logic that a future code path could forget.
 *
 * Hand-applied because `db:push` is broken against Neon PG18 (CLAUDE.md).
 * Idempotent — safe to re-run; it checks before adding.
 *
 *   npx tsx --conditions react-server --env-file=.env scripts/migrate-token-parentage.ts
 */
import { sql } from "drizzle-orm";
import { controlDb } from "@/db";

/** The neon-http driver returns either an array or a {rows} envelope. */
function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

async function main() {
  const [probe] = rowsOf<{ exists: boolean }>(
    await controlDb.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'project_tokens' AND column_name = 'minted_by_token_id'
      ) AS exists`),
  );

  if (probe?.exists) {
    console.log("minted_by_token_id already present — nothing to do");
  } else {
    await controlDb.execute(sql`
      ALTER TABLE project_tokens
        ADD COLUMN minted_by_token_id uuid
        REFERENCES project_tokens(id) ON DELETE CASCADE`);
    console.log("added project_tokens.minted_by_token_id (ON DELETE CASCADE)");
  }

  // Revoking a parent cascades to its children; without this index that is a
  // sequential scan of every token on every revoke.
  await controlDb.execute(sql`
    CREATE INDEX IF NOT EXISTS project_tokens_minted_by_idx
      ON project_tokens (minted_by_token_id)`);
  console.log("ensured index project_tokens_minted_by_idx");

  const [check] = rowsOf<{ confdeltype: string }>(
    await controlDb.execute(sql`
      SELECT confdeltype FROM pg_constraint
      WHERE conrelid = 'project_tokens'::regclass
        AND confrelid = 'project_tokens'::regclass`),
  );
  console.log(
    check?.confdeltype === "c"
      ? "verified: self-reference is ON DELETE CASCADE"
      : `WARNING: unexpected delete rule "${check?.confdeltype ?? "none"}" — cascade revoke is NOT guaranteed`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
