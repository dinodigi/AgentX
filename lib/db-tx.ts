import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import ws from "ws";
import * as schema from "@/db/schema";

/**
 * Interactive transactions for the (few) operations that need them — `transact`.
 *
 * The default `db` uses neon-http: one stateless HTTPS round-trip per query, no
 * interactive `BEGIN ... COMMIT`. A multi-op all-or-nothing batch needs a real
 * transaction, which neon provides over a WebSocket Pool. We build a fresh
 * single-connection pool per call and close it in `finally` — deliberately NOT
 * pooled across serverless invocations (that needs lifecycle work we don't have).
 *
 * `ws` is a pure-JS dependency (no native build) so this works identically on
 * Netlify Functions (Node 18/20, no global WebSocket) and Render.
 */

// Node 21+ has a global WebSocket, but Netlify's Node 18/20 does not — always
// wire the ws package so the driver never depends on the runtime version.
neonConfig.webSocketConstructor = ws;

/**
 * The query-builder surface the entry cores use. Both `db` (neon-http) and a
 * neon-serverless transaction satisfy it, so a core runs unchanged on either.
 */
export type DbExecutor = Pick<
  NeonHttpDatabase<typeof schema>,
  "select" | "insert" | "update" | "delete" | "execute"
>;

export async function withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const txDb = drizzle(pool, { schema });
    // Both drizzle flavors expose the same insert/update/delete/select surface;
    // the cast bridges their distinct branded database types.
    return await txDb.transaction((tx) => fn(tx as unknown as DbExecutor));
  } finally {
    await pool.end();
  }
}
