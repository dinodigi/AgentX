import "server-only";
import { and, count, eq } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { revalidateTag } from "next/cache";
import { controlDb } from "@/db";
import { entries, entriesTrash, assets, projectConnectors, type ProjectConnector } from "@/db/schema";
import { tenantDb, evictTenantClient } from "./data-plane";
import { migrateTenantDb, TENANT_SCHEMA_VERSION } from "./tenant-migrations";
import { connectorsTag } from "./connectors";
import { encryptSecret, decryptSecret } from "./crypto";
import { replayCollectionIndexes } from "./collections";

/**
 * The `neon` connector (A2, BYO mode): the project's own Postgres becomes its
 * data plane. Connect = validate → install (migration runner) → store
 * encrypted → route (lib/data-plane picks it up on the next resolve). The
 * generic connector form CANNOT save this type (FormConnectorType excludes
 * it) — this module is the only path, so a stored neon connector always went
 * through validation + install.
 *
 * BYO invariant: we NEVER create or drop the tenant's database. Disconnect
 * only removes our routing record and evicts cached clients.
 */

neonConfig.webSocketConstructor = ws;

/**
 * Direct (uncached) row access: the connect flow must never act on a stale
 * cached view of itself, and this module also runs outside a Next request
 * (provisioning scripts, exercises). Cache-tag revalidation is best-effort —
 * in a server action it refreshes getConnector's view; outside Next it
 * doesn't exist, and the direct reads here don't need it.
 */
async function neonRow(projectId: string): Promise<ProjectConnector | null> {
  const [row] = await controlDb
    .select()
    .from(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "neon")))
    .limit(1);
  return row ?? null;
}

function revalidateConnectors(projectId: string): void {
  try {
    revalidateTag(connectorsTag(projectId));
  } catch {
    // Outside a Next request context (script/exercise) — nothing to refresh.
  }
}

export interface ConnectResult {
  ok: boolean;
  detail: string;
  /** Set on success: the schema version the database is now at. */
  schemaVersion?: number;
}

const PG_MIN_VERSION_NUM = 150000; // PG15+ (Neon ships 15–18)

function parseConnString(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    if (!u.hostname || !u.pathname || u.pathname === "/") return null;
    return u;
  } catch {
    return null;
  }
}

/** Connectivity + version + privilege probe, over a real session. */
async function probeDatabase(connString: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const pool = new Pool({ connectionString: connString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const { rows } = await pool.query(`
      SELECT current_setting('server_version_num')::int AS vnum,
             current_setting('server_version') AS v,
             has_database_privilege(current_user, current_database(), 'CREATE') AS can_create`);
    const r = rows[0] as { vnum: number; v: string; can_create: boolean };
    if (r.vnum < PG_MIN_VERSION_NUM) {
      return { ok: false, detail: `Postgres ${r.v} is too old — the data plane needs 15+` };
    }
    if (!r.can_create) {
      return {
        ok: false,
        detail: "this role cannot CREATE in that database — the data plane needs to install tables and indexes; grant CREATE or use the owning role",
      };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `could not connect: ${msg}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Attach a BYO Postgres as this project's data plane.
 *
 * Greenfield rule: content migration is out of scope (design §11), so the
 * project's CURRENT plane must be empty — attaching mid-life would strand
 * existing content in the shared DB (or a previous tenant DB). Re-running
 * with the SAME string is an allowed no-op heal (re-install + index replay).
 */
export async function connectNeonDatabase(projectId: string, rawConnString: string): Promise<ConnectResult> {
  const url = parseConnString(rawConnString);
  if (!url) {
    return { ok: false, detail: "that doesn't look like a postgres:// connection string (host + database required)" };
  }
  const connString = rawConnString.trim();

  const existing = await neonRow(projectId);
  const storedConn = existing?.secretEnc ? decryptSecret(existing.secretEnc) : null;
  const sameString = storedConn !== null && storedConn === connString;

  // 1) Reachability + version + CREATE privilege, over a real session.
  const probe = await probeDatabase(connString);
  if (!probe.ok) return { ok: false, detail: probe.detail };

  // 2) Zero-content guard on the CURRENT plane (skipped for a same-string
  //    heal). tenantDb resolves to the control DB before the first attach and
  //    to the old tenant DB on a string change — both are exactly the plane
  //    whose content would be stranded.
  if (!sameString) {
    let contentRows: number;
    try {
      const cur = await tenantDb(projectId);
      const [e, t, a] = await Promise.all([
        cur.select({ n: count() }).from(entries).where(eq(entries.projectId, projectId)),
        cur.select({ n: count() }).from(entriesTrash).where(eq(entriesTrash.projectId, projectId)),
        cur.select({ n: count() }).from(assets).where(eq(assets.projectId, projectId)),
      ]);
      contentRows = (e[0]?.n ?? 0) + (t[0]?.n ?? 0) + (a[0]?.n ?? 0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        detail: `could not verify the project's current plane is empty (${msg}) — if you are replacing an unreachable database, disconnect first, then connect the new one`,
      };
    }
    if (contentRows > 0) {
      return {
        ok: false,
        detail: `this project already has ${contentRows} content row(s) on its current data plane — content migration isn't supported yet; connect a database before creating content${existing ? ", or disconnect the current one first" : ""}`,
      };
    }
  }

  // 3) Install / verify the data-plane schema (idempotent, advisory-locked).
  try {
    await migrateTenantDb(connString);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `schema install failed: ${msg} — nothing was stored` };
  }

  // 4) Store (encrypted) + route. From the next resolve, content ops hit the
  //    tenant DB. Config keeps only non-secrets (mode + host for display).
  const values = {
    projectId,
    type: "neon" as const,
    config: { mode: "byo", host: url.hostname },
    secretEnc: encryptSecret(connString),
    status: "connected",
    updatedAt: new Date(),
  };
  await controlDb
    .insert(projectConnectors)
    .values(values)
    .onConflictDoUpdate({
      target: [projectConnectors.projectId, projectConnectors.type],
      set: { config: values.config, secretEnc: values.secretEnc, status: "connected", updatedAt: values.updatedAt },
    });
  revalidateConnectors(projectId);
  if (storedConn && storedConn !== connString) evictTenantClient(storedConn);

  // 5) Replay per-collection partial indexes (unique + search) on the now-
  //    routed tenant DB — they are not part of the fixed DDL set.
  try {
    await replayCollectionIndexes(projectId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail: `connected, but replaying collection indexes failed: ${msg} — run Test connector to retry, or re-connect`,
      schemaVersion: TENANT_SCHEMA_VERSION,
    };
  }

  return {
    ok: true,
    detail: `connected — schema v${TENANT_SCHEMA_VERSION} installed on ${url.hostname}; this project's content now lives in your database`,
    schemaVersion: TENANT_SCHEMA_VERSION,
  };
}

/**
 * Detach the tenant database: remove our routing record + evict cached
 * clients. The database itself is NEVER touched (it's the tenant's). Any
 * content in it becomes unreachable through the platform until reconnected —
 * the caller's UI must say so.
 */
export async function disconnectNeonDatabase(projectId: string): Promise<{ ok: boolean; detail: string }> {
  const existing = await neonRow(projectId);
  const conn = existing?.secretEnc ? decryptSecret(existing.secretEnc) : null;
  await controlDb
    .delete(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "neon")));
  revalidateConnectors(projectId);
  if (conn) evictTenantClient(conn);
  return {
    ok: true,
    detail: "disconnected — your database and its data are untouched; the project now runs on the shared plane (empty) until you reconnect",
  };
}
