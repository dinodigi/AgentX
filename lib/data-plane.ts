import "server-only";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon, Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleWs } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { controlDb } from "@/db";
import * as schema from "@/db/schema";
import { projectConnectors } from "@/db/schema";
import { decryptSecret } from "./crypto";
import type { DbExecutor } from "./db-tx";

/**
 * The per-project data-plane resolver (A1). Control-plane tables use `controlDb`
 * directly; content tables (entries, trash, versions, changes, assets, and their
 * derived logs) route through `tenantDb(projectId, env)`.
 *
 * Today no project has a `neon` connector, so every project resolves to the
 * control DB (the fallback that lets the smoke suite and free/dev projects run
 * without provisioning real Neon). A2 adds the connector; the moment a project
 * has one, its content moves to its own database with zero call-site changes.
 */

// Node 21+ has a global WebSocket; Render/Netlify Node may not — wire ws so the
// serverless Pool (transact) never depends on the runtime version.
neonConfig.webSocketConstructor = ws;

export type Env = "prod" | "dev";

// neon-http is stateless per query, but the drizzle client wrapper is worth
// reusing — cache one per connection string.
const clientCache = new Map<string, DbExecutor>();

function tenantClient(connString: string): DbExecutor {
  let c = clientCache.get(connString);
  if (!c) {
    c = drizzle(neon(connString), { schema }) as unknown as DbExecutor;
    clientCache.set(connString, c);
  }
  return c;
}

/** Drop a cached client — call on neon-connector rotate/disconnect (A2). */
export function evictTenantClient(connString: string): void {
  clientCache.delete(connString);
}

/**
 * The tenant connection string for a project + environment, or null when the
 * project has NO neon connector (→ the caller uses the control-DB fallback).
 *
 * FAIL-CLOSED: a connector that EXISTS but can't be resolved — the env slot is
 * missing, or decryption fails (e.g. a misconfigured CONNECTOR_MASTER_KEY) —
 * THROWS. It must never silently degrade to the control DB, which would
 * read/write the wrong database and could leak a tenant's content into the
 * shared control plane.
 */
async function resolveTenantConnString(projectId: string, env: Env): Promise<string | null> {
  const [row] = await controlDb
    .select({ secretEnc: projectConnectors.secretEnc, secretsEnc: projectConnectors.secretsEnc })
    .from(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "neon")))
    .limit(1);
  if (!row) return null; // no neon connector — fall back to the control DB
  const enc = row.secretsEnc?.[env] ?? (env === "prod" ? row.secretEnc : null);
  if (!enc) {
    throw new Error(`neon connector for project ${projectId} has no '${env}' connection string (fail-closed)`);
  }
  return decryptSecret(enc); // throws on a bad master key — fail-closed, correct
}

/**
 * The executor for a project's data-plane tables. Returns the control DB while
 * the project has no neon connector; otherwise its own tenant DB. `env` selects
 * the environment slot (A3/A5 wire dev); everything is 'prod' until then.
 */
export async function tenantDb(projectId: string, env: Env = "prod"): Promise<DbExecutor> {
  const conn = await resolveTenantConnString(projectId, env);
  return conn ? tenantClient(conn) : (controlDb as unknown as DbExecutor);
}

/**
 * An interactive transaction on a project's data plane (used by `transact`). A
 * fresh single-connection Pool per call, closed in `finally` — inherits
 * withTransaction's serverless-safety. Falls back to the control DB's
 * connection string when the project has no neon connector.
 */
export async function withTenantTransaction<T>(
  projectId: string,
  fn: (tx: DbExecutor) => Promise<T>,
  env: Env = "prod",
): Promise<T> {
  const conn = (await resolveTenantConnString(projectId, env)) ?? process.env.DATABASE_URL!;
  const pool = new Pool({ connectionString: conn, max: 1 });
  try {
    const txDb = drizzleWs(pool, { schema });
    return await txDb.transaction((tx) => fn(tx as unknown as DbExecutor));
  } finally {
    await pool.end();
  }
}
