import "server-only";
import { and, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon, Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleWs } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { controlDb } from "@/db";
import * as schema from "@/db/schema";
import { projectConnectors } from "@/db/schema";
import { decryptSecret } from "./crypto";
import { migrateTenantDb } from "./tenant-migrations";
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
  verifiedConnStrings.delete(connString);
}

// ---------------------------------------------------------------------------
// Migrate-before-first-use gate (A2, design §7 mitigation 2)
// ---------------------------------------------------------------------------

/** Conn strings this process has verified at the current schema version. */
const verifiedConnStrings = new Set<string>();
const MIGRATE_GATE_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Ensure the tenant DB behind `conn` is at the current schema version before
 * any query runs — once per process per connection string. migrateTenantDb is
 * advisory-locked and idempotent, so concurrent cold starts can't double-apply,
 * and a resumed/behind DB self-heals on its next connect. Failure QUARANTINES
 * the connector (status → error, best-effort) and throws — content ops on an
 * unusable tenant DB must fail closed, loudly, not write into the wrong plane.
 */
async function ensureTenantMigrated(projectId: string, conn: string): Promise<void> {
  if (verifiedConnStrings.has(conn)) return;
  try {
    await withTimeout(migrateTenantDb(conn), MIGRATE_GATE_TIMEOUT_MS, "tenant schema check");
    verifiedConnStrings.add(conn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Quarantine: flip the connector row so the admin card + health probe show
    // it. Plain row update (no revalidateTag — this runs during renders too);
    // the card's Test button re-probes and refreshes the cached view.
    await controlDb
      .update(projectConnectors)
      .set({ status: "error", updatedAt: new Date() })
      .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "neon")))
      .catch(() => {});
    throw new Error(
      `tenant database for project ${projectId} is not usable (${msg}) — connector quarantined; fix the database or its connection string, then re-test the connector`,
    );
  }
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
  if (!conn) return controlDb as unknown as DbExecutor;
  await ensureTenantMigrated(projectId, conn);
  return tenantClient(conn);
}

export interface TenantContentStats {
  entries: number;
  /** Sum of assets.size tenant-side — the console's media-vs-cap column (B4). */
  assetBytes: number;
  /** Total stored entry JSONB (post-TOAST) — the 4a cap / stats dimension. */
  dataBytes: number;
  lastActivity: string | null;
}

/**
 * Per-project content stats for CONNECTOR-BACKED projects — the cross-project
 * surfaces (fleet dashboard, operator console) can't GROUP BY across tenant
 * DBs, so they fan out here for exactly the projects whose content left the
 * shared table (bounded: few at launch; B3's usage rollups replace this at
 * scale). An unreachable/quarantined tenant DB yields zeros rather than a
 * crashed dashboard — its connector's error status is the visible signal.
 */
export async function tenantContentStats(projectIds: string[]): Promise<Map<string, TenantContentStats>> {
  const out = new Map<string, TenantContentStats>();
  await Promise.all(
    projectIds.map(async (pid) => {
      try {
        const tdb = await tenantDb(pid);
        const [[row], [bytes]] = await Promise.all([
          tdb
            .select({
              n: count(),
              last: sql<string | null>`max(${schema.entries.updatedAt})`,
              dataBytes: sql<string>`coalesce(sum(pg_column_size(${schema.entries.data})), 0)`,
            })
            .from(schema.entries)
            .where(eq(schema.entries.projectId, pid)),
          tdb
            .select({ total: sql<string>`coalesce(sum(${schema.assets.size}::bigint), 0)` })
            .from(schema.assets)
            .where(eq(schema.assets.projectId, pid)),
        ]);
        out.set(pid, {
          entries: Number(row?.n ?? 0),
          assetBytes: Number(bytes?.total ?? 0),
          dataBytes: Number(row?.dataBytes ?? 0),
          lastActivity: row?.last ? new Date(row.last).toISOString() : null,
        });
      } catch {
        out.set(pid, { entries: 0, assetBytes: 0, dataBytes: 0, lastActivity: null });
      }
    }),
  );
  return out;
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
  const resolved = await resolveTenantConnString(projectId, env);
  if (resolved) await ensureTenantMigrated(projectId, resolved);
  const conn = resolved ?? process.env.DATABASE_URL!;
  const pool = new Pool({ connectionString: conn, max: 1 });
  try {
    const txDb = drizzleWs(pool, { schema });
    return await txDb.transaction((tx) => fn(tx as unknown as DbExecutor));
  } finally {
    await pool.end();
  }
}
