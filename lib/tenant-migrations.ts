import "server-only";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

/**
 * The tenant-DB migration runner (A1.4). Every tenant database carries the
 * data-plane table set, versioned by a `_schema_migrations` table inside that
 * same database. Steps are hand-authored ordered SQL (design §7: drizzle-kit
 * push is broken against Neon PG18, and generated diffs are not reviewable) —
 * deterministic, no drizzle-kit dependency anywhere near the hot path.
 *
 * v1 = the current data-plane schema: the 8 tenant tables + their indexes,
 * harvested from db/schema.ts (drizzle-kit generate, 2026-07-11) and reduced:
 * NO foreign keys — `projects` and `collections` live in the control plane, so
 * every FK the control DB carries on these tables is structurally impossible
 * here (the accepted FK asymmetry, A0 decision 6). Their cascades are replaced
 * by explicit call-site deletes (deleteCollection's sweep; B2 project delete).
 * Per-collection partial indexes (entries_uq_*, entries_fts_*) are NOT part of
 * the fixed set — provisioning replays them per collection via the runtime
 * index syncs (syncUniqueIndexes/syncSearchIndex) after the runner finishes.
 *
 * THE COMPATIBILITY CONTRACT (expand/contract — binding on every future step):
 * 1. Steps are append-only; never edit a shipped step. Each statement is
 *    idempotent (IF NOT EXISTS / IF EXISTS), so a re-run is a no-op.
 * 2. EXPAND: new columns land additively (nullable or defaulted) in version N,
 *    and deployed code must not reference them until every tenant DB is at N —
 *    drizzle emits the full declared column set on select()/returning(), so a
 *    lagging tenant DB 500s on reads AND writes the moment schema.ts gets a
 *    column its DB lacks. Ship the step, migrate the fleet, THEN ship code
 *    that uses the column.
 * 3. CONTRACT: drop a column/table one release AFTER the last code that
 *    referenced it is gone, as its own step.
 * 4. Data backfills are their own statements inside a step, never destructive
 *    rewrites; anything that can fail on tenant data must leave the DB usable.
 * 5. Every statement must be transaction-safe: each step runs inside BEGIN/
 *    COMMIT with its version row, so no CREATE INDEX CONCURRENTLY, no
 *    CREATE DATABASE, no VACUUM in a step.
 *
 * The runner opens its own single-connection Pool (websocket driver): the
 * advisory lock that serializes concurrent runs is session-scoped, which the
 * stateless neon-http transport cannot hold across statements.
 */

// Node 21+ has a global WebSocket; Render/Netlify Node may not (same wiring as
// lib/data-plane.ts — kept local so this module has no import cycle risk).
neonConfig.webSocketConstructor = ws;

export interface TenantMigration {
  version: number;
  name: string;
  /** Executed in order inside one transaction with the version-row insert. */
  statements: string[];
}

/** The version a fully-migrated tenant DB reports (A2's health probe target). */
export const TENANT_SCHEMA_VERSION = 1;

// Stable, arbitrary advisory-lock key namespacing "tenant schema migration".
const MIGRATION_LOCK_KEY = 0x70_6c_75_67; // "plug"

/**
 * Session semantics (advisory locks, multi-statement transactions) are broken
 * through PgBouncer in transaction mode — which is exactly what Neon's
 * `-pooler` endpoints run. Normalize to the direct endpoint for the runner's
 * session; harmless for hosts without the Neon pooler suffix. (A2's BYO
 * validation applies the same normalization before storing the string.)
 */
function directEndpoint(connString: string): string {
  try {
    const u = new URL(connString);
    u.hostname = u.hostname.replace(/-pooler(?=\.)/, "");
    return u.toString();
  } catch {
    return connString; // not URL-shaped — let the driver produce the real error
  }
}

const V1_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "entries" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "collection_id" uuid NOT NULL,
    "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "idempotency_key" text,
    "handled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "entries_collection_idx" ON "entries" USING btree ("collection_id")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "entries_idempotency_idx" ON "entries" USING btree ("collection_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS "entries_trash" (
    "id" uuid PRIMARY KEY NOT NULL,
    "project_id" uuid NOT NULL,
    "collection_id" uuid NOT NULL,
    "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "idempotency_key" text,
    "handled_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    "deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
    "deleted_by" jsonb DEFAULT '{"type":"unknown"}'::jsonb NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "entries_trash_collection_idx" ON "entries_trash" USING btree ("collection_id","deleted_at")`,
  `CREATE INDEX IF NOT EXISTS "entries_trash_project_idx" ON "entries_trash" USING btree ("project_id","deleted_at")`,

  `CREATE TABLE IF NOT EXISTS "entry_versions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "collection_id" uuid NOT NULL,
    "entry_id" uuid NOT NULL,
    "data" jsonb NOT NULL,
    "changed_fields" jsonb,
    "actor" jsonb DEFAULT '{"type":"unknown"}'::jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "entry_versions_entry_idx" ON "entry_versions" USING btree ("entry_id","created_at")`,

  `CREATE TABLE IF NOT EXISTS "entry_changes" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "seq" bigserial NOT NULL,
    "project_id" uuid NOT NULL,
    "collection_id" uuid NOT NULL,
    "collection_name" text NOT NULL,
    "entry_id" uuid NOT NULL,
    "kind" text NOT NULL,
    "data" jsonb NOT NULL,
    "prev_data" jsonb,
    "changed_fields" jsonb,
    "vis" jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "entry_changes_project_seq_idx" ON "entry_changes" USING btree ("project_id","seq")`,
  `CREATE INDEX IF NOT EXISTS "entry_changes_collection_seq_idx" ON "entry_changes" USING btree ("collection_id","seq")`,
  `CREATE INDEX IF NOT EXISTS "entry_changes_project_created_idx" ON "entry_changes" USING btree ("project_id","created_at")`,

  `CREATE TABLE IF NOT EXISTS "assets" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "r2_key" text NOT NULL,
    "filename" text NOT NULL,
    "content_type" text NOT NULL,
    "size" text NOT NULL,
    "url" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS "transact_receipts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "idempotency_key" text NOT NULL,
    "results" jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "transact_receipts_key_idx" ON "transact_receipts" USING btree ("project_id","idempotency_key")`,

  `CREATE TABLE IF NOT EXISTS "audit_log" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "collection_name" text NOT NULL,
    "entry_id" uuid NOT NULL,
    "action" text NOT NULL,
    "actor" jsonb DEFAULT '{"type":"unknown"}'::jsonb NOT NULL,
    "changed_fields" jsonb,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "audit_log_project_time_idx" ON "audit_log" USING btree ("project_id","created_at")`,

  `CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "project_id" uuid NOT NULL,
    "collection_id" uuid,
    "url" text NOT NULL,
    "event" text NOT NULL,
    "payload" jsonb NOT NULL,
    "status" text NOT NULL,
    "attempts" text NOT NULL,
    "last_error" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "webhook_deliveries_project_idx" ON "webhook_deliveries" USING btree ("project_id")`,
];

/** Append-only. Never edit a shipped step — add the next version. */
export const TENANT_MIGRATIONS: TenantMigration[] = [
  { version: 1, name: "data-plane-v1", statements: V1_STATEMENTS },
];

export interface MigrateResult {
  /** Version found before the run (0 = fresh database). */
  from: number;
  /** Version after the run (= TENANT_SCHEMA_VERSION on success). */
  to: number;
  /** Names of the steps this run applied (empty = already current). */
  applied: string[];
}

/**
 * Bring the tenant DB behind `connString` to the current schema version.
 * Serialized by a session advisory lock (two concurrent provisions/drains
 * can't double-apply); each step commits atomically WITH its version row, so
 * a crash mid-step rolls back to the previous version cleanly. Throws on the
 * first failing step with the step named — the caller (A2's provisioning
 * state machine) decides retry vs quarantine; it must never be swallowed.
 */
export async function migrateTenantDb(connString: string): Promise<MigrateResult> {
  const pool = new Pool({ connectionString: directEndpoint(connString), max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

      await client.query(`CREATE TABLE IF NOT EXISTS "_schema_migrations" (
        "version" integer PRIMARY KEY,
        "name" text NOT NULL,
        "applied_at" timestamp with time zone DEFAULT now() NOT NULL
      )`);
      const { rows } = await client.query(
        `SELECT coalesce(max(version), 0) AS v FROM "_schema_migrations"`,
      );
      const from = Number(rows[0].v);

      const applied: string[] = [];
      for (const m of TENANT_MIGRATIONS) {
        if (m.version <= from) continue;
        try {
          await client.query("BEGIN");
          for (const stmt of m.statements) await client.query(stmt);
          await client.query(
            `INSERT INTO "_schema_migrations" (version, name) VALUES ($1, $2)`,
            [m.version, m.name],
          );
          await client.query("COMMIT");
          applied.push(m.name);
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw new Error(
            `tenant migration v${m.version} "${m.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return { from, to: TENANT_SCHEMA_VERSION, applied };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * The applied schema version of the tenant DB behind `connString` (0 = the
 * marker table is absent — never migrated). A2's neon-connector health probe:
 * healthy = connects AND reports TENANT_SCHEMA_VERSION.
 */
export async function tenantSchemaVersion(connString: string): Promise<number> {
  const pool = new Pool({ connectionString: connString, max: 1 });
  try {
    const { rows } = await pool.query(`
      SELECT CASE WHEN to_regclass('"_schema_migrations"') IS NULL THEN 0
             ELSE (SELECT coalesce(max(version), 0) FROM "_schema_migrations") END AS v`);
    return Number(rows[0].v);
  } finally {
    await pool.end();
  }
}
