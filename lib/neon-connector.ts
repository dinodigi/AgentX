import "server-only";
import { and, count, eq } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { revalidateTag } from "next/cache";
import { controlDb } from "@/db";
import { entries, entriesTrash, assets, projectConnectors, type ProjectConnector } from "@/db/schema";
import { connectorRefusal } from "./caps";
import { tenantDb, evictTenantClient } from "./data-plane";
import { migrateTenantDb, TENANT_SCHEMA_VERSION } from "./tenant-migrations";
import { connectorsTag } from "./connectors";
import { encryptSecret, decryptSecret } from "./crypto";
import { replayCollectionIndexes } from "./collections";
import { createNeonProject, waitForNeonProject, deleteNeonProject } from "./neon-api";

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
  const refusal = await connectorRefusal(projectId); // B2: sandboxes stay on the shared plane
  if (refusal) return { ok: false, detail: refusal };
  const url = parseConnString(rawConnString);
  if (!url) {
    return { ok: false, detail: "that doesn't look like a postgres:// connection string (host + database required)" };
  }
  const connString = rawConnString.trim();

  const existing = await neonRow(projectId);
  if (existing?.config?.mode === "managed") {
    // Overwriting a managed row would orphan a paid Neon project we own.
    return { ok: false, detail: "this project has a managed database — deprovision it before connecting your own" };
  }
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
 * Provision a MANAGED database (A3): a Neon project of the tenant's own, in
 * OUR org, our API key — one Neon project per tenant project (design §13 Q5).
 *
 * Resumable, handle-first (design §8): the `neonProjectId` teardown handle is
 * stored BEFORE anything else can fail, so a half-provisioned project is
 * always cleanable. A retry after a mid-sequence failure tears down the
 * orphan (its connection was never stored → it never held content) and
 * creates fresh — every step idempotent from the caller's point of view.
 */
export async function provisionManagedDatabase(projectId: string): Promise<ConnectResult> {
  const refusal = await connectorRefusal(projectId); // B2: sandboxes stay on the shared plane
  if (refusal) return { ok: false, detail: refusal };
  const existing = await neonRow(projectId);
  if (existing?.config?.mode === "byo") {
    return { ok: false, detail: "this project uses a BYO database — disconnect it first if you want a managed one" };
  }
  if (existing?.config?.mode === "managed" && existing.secretEnc) {
    // A stored connection string means the database may HOLD content — never
    // replace it from here. Connected = nothing to do; quarantined = heal via
    // Test (the migrate gate self-heals) or explicitly Deprovision.
    return {
      ok: false,
      detail:
        existing.status === "connected"
          ? "a managed database is already provisioned for this project"
          : `a managed database exists but is ${existing.status} — run Test to heal it, or Deprovision it first`,
    };
  }

  // Zero-content guard, same greenfield rule as BYO. Counted on the CONTROL
  // plane directly: with no row (fallback) that IS the content plane, and a
  // secret-less managed handle never routed a single write (tenantDb would
  // fail closed on it — found by the A3 exercise, so don't resolve through it).
  const [e, t, a] = await Promise.all([
    controlDb.select({ n: count() }).from(entries).where(eq(entries.projectId, projectId)),
    controlDb.select({ n: count() }).from(entriesTrash).where(eq(entriesTrash.projectId, projectId)),
    controlDb.select({ n: count() }).from(assets).where(eq(assets.projectId, projectId)),
  ]);
  const contentRows = (e[0]?.n ?? 0) + (t[0]?.n ?? 0) + (a[0]?.n ?? 0);
  if (contentRows > 0) {
    return {
      ok: false,
      detail: `this project already has ${contentRows} content row(s) on the shared plane — content migration isn't supported yet; provision before creating content`,
    };
  }

  // Resume-by-replacement: a prior attempt that stored a handle but never a
  // connection string is an orphan — tear it down before creating fresh.
  const orphanId = existing?.config?.mode === "managed" ? existing.config.neonProjectId : null;
  if (orphanId && !existing?.secretEnc) {
    try {
      await deleteNeonProject(orphanId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `a previous half-provisioned database could not be cleaned up (${msg}) — retry` };
    }
  }

  // 1) Create. 2) HANDLE FIRST: persist neonProjectId before anything else can
  //    fail. 3) Wait ready. 4) Install schema. 5) Store the connection string +
  //    flip connected. 6) Replay per-collection indexes.
  let created: Awaited<ReturnType<typeof createNeonProject>>;
  try {
    created = await createNeonProject(`agentx-${projectId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `could not create the managed database: ${msg}` };
  }

  const handleValues = {
    projectId,
    type: "neon" as const,
    config: { mode: "managed", neonProjectId: created.neonProjectId, host: safeHost(created.connectionUri) },
    secretEnc: null as string | null,
    status: "provisioning",
    updatedAt: new Date(),
  };
  await controlDb
    .insert(projectConnectors)
    .values(handleValues)
    .onConflictDoUpdate({
      target: [projectConnectors.projectId, projectConnectors.type],
      set: { config: handleValues.config, secretEnc: null, status: "provisioning", updatedAt: handleValues.updatedAt },
    });
  revalidateConnectors(projectId);

  try {
    await waitForNeonProject(created.neonProjectId);
    await migrateTenantDb(created.connectionUri);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await controlDb
      .update(projectConnectors)
      .set({ status: "error", updatedAt: new Date() })
      .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "neon")))
      .catch(() => {});
    revalidateConnectors(projectId);
    return { ok: false, detail: `database created but not ready (${msg}) — retry to clean up and provision fresh` };
  }

  await controlDb
    .update(projectConnectors)
    .set({ secretEnc: encryptSecret(created.connectionUri), status: "connected", updatedAt: new Date() })
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "neon")));
  revalidateConnectors(projectId);

  try {
    await replayCollectionIndexes(projectId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `provisioned, but replaying collection indexes failed: ${msg} — run Test connector to retry`,
      schemaVersion: TENANT_SCHEMA_VERSION,
    };
  }

  return {
    ok: true,
    detail: `managed database provisioned — schema v${TENANT_SCHEMA_VERSION}; this project's content now lives in its own database`,
    schemaVersion: TENANT_SCHEMA_VERSION,
  };
}

/**
 * Tear down a MANAGED database: delete the Neon project (recoverable on
 * Neon's side for 7 days), then drop our routing. LOUD on failure — a paid
 * database must never be silently orphaned. Destroys the project's content;
 * the caller gates this behind an explicit confirm.
 */
export async function deprovisionManagedDatabase(projectId: string): Promise<{ ok: boolean; detail: string }> {
  const existing = await neonRow(projectId);
  if (!existing || existing.config?.mode !== "managed") {
    return { ok: false, detail: "this project has no managed database" };
  }
  const neonProjectId = existing.config.neonProjectId;
  if (neonProjectId) {
    try {
      await deleteNeonProject(neonProjectId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `could not delete the managed database (${msg}) — nothing was removed; retry` };
    }
  }
  const conn = existing.secretEnc ? decryptSecret(existing.secretEnc) : null;
  await controlDb
    .delete(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "neon")));
  revalidateConnectors(projectId);
  if (conn) evictTenantClient(conn);
  return {
    ok: true,
    detail: "managed database deleted (recoverable on Neon for 7 days) — the project is back on the shared plane, empty",
  };
}

function safeHost(connString: string): string {
  try {
    return new URL(connString).hostname;
  } catch {
    return "";
  }
}

/**
 * Detach the tenant database: remove our routing record + evict cached
 * clients. The database itself is NEVER touched (it's the tenant's). Any
 * content in it becomes unreachable through the platform until reconnected —
 * the caller's UI must say so. BYO only — a managed database goes through
 * deprovisionManagedDatabase (which actually deletes it) instead.
 */
export async function disconnectNeonDatabase(projectId: string): Promise<{ ok: boolean; detail: string }> {
  const existing = await neonRow(projectId);
  if (existing?.config?.mode === "managed") {
    return { ok: false, detail: "this is a managed database — use Deprovision (it deletes the database) instead of Disconnect" };
  }
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
