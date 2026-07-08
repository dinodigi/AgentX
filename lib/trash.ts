import { and, eq, sql, desc, lt } from "drizzle-orm";
import { db } from "@/db";
import { entries, entriesTrash, entryVersions, type Collection, type AuditActor } from "@/db/schema";
import { emitEntryEvent } from "./events";
import { recordAudit } from "./audit";
import { defer } from "./defer";
import { ValidationError } from "./validation";
import { rethrowUnique, dbErrorText, sweepExpiredTrash } from "./entries";
import { recordChange } from "./changes";

/**
 * Trash lifecycle — restore and list. The delete → trash MOVE lives in
 * `deleteEntryCore` (lib/entries.ts), the single write choke point, so every
 * delete path trashes uniformly. Restore is the mirror move back.
 */

const UNKNOWN_ACTOR: AuditActor = { type: "unknown" };

export interface TrashRow {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  deletedAt: string;
  deletedBy: AuditActor;
}

/**
 * Move a trashed entry back into its collection (mirror of the delete CTE).
 * Re-emits `created` with {restored:true, deletedAt} through the single emit
 * point, so consumers that missed the delete can resync. A restored entry keeps
 * its original id and createdAt — webhook receivers that INSERT (not upsert) on
 * entry.created must honor the restored flag (its id may be one they've seen).
 */
export async function restoreEntry(
  projectId: string,
  collection: Collection,
  id: string,
  actor: AuditActor = UNKNOWN_ACTOR,
): Promise<{ id: string; data: Record<string, unknown> }> {
  let result;
  try {
    result = await db.execute(sql`
      WITH moved AS (
        DELETE FROM ${entriesTrash}
        WHERE ${entriesTrash.id} = ${id} AND ${entriesTrash.collectionId} = ${collection.id}
        RETURNING *
      ),
      ins AS (
        INSERT INTO ${entries}
          (id, project_id, collection_id, data, idempotency_key, handled_at, created_at, updated_at)
        SELECT id, project_id, collection_id, data, idempotency_key, handled_at, created_at, updated_at
        FROM moved
        RETURNING id
      )
      SELECT moved.id, moved.data, moved.deleted_at AS "deletedAt" FROM moved
    `);
  } catch (e) {
    // The idempotency key came back into use while this row sat in trash — a
    // retried create already claimed it. Distinguish from a plain unique clash.
    if (/entries_idempotency_idx/.test(dbErrorText(e))) {
      throw new ValidationError(
        `idempotency key is back in use — a retried create replaced this entry while it was trashed; purge the trash row instead`,
        "E_CONFLICT",
      );
    }
    rethrowUnique(e);
  }

  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  const row = (Array.isArray(rows) ? rows[0] : undefined) as
    | { id: string; data: Record<string, unknown>; deletedAt: string }
    | undefined;
  if (!row) throw new ValidationError(`no trashed entry ${id} in "${collection.name}"`, "E_NOT_FOUND");

  const restored = { id: row.id, data: row.data };
  // Feed a `created` change (inline) — a synced client that saw the delete
  // tombstone must see the entry reappear.
  await recordChange({ projectId, collection, kind: "created", entryId: row.id, data: row.data });
  defer(() =>
    emitEntryEvent(collection, "created", restored, undefined, {
      restored: true,
      deletedAt: row.deletedAt,
    }),
  );
  recordAudit({
    projectId,
    collectionName: collection.name,
    entryId: row.id,
    action: "restore",
    actor,
  });
  return restored;
}

/**
 * List trashed entries newest-deleted first, across all collections in the
 * project. Keyset over deletedAt via an opaque `before` cursor (ISO string);
 * `hasMore` uses the limit+1 trick.
 */
export async function listTrash(
  projectId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<{ rows: TrashRow[]; hasMore: boolean }> {
  // Opportunistic retention: clear trash older than 30 days on every listing.
  defer(() => sweepExpiredTrash(projectId));

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const conds = [eq(entriesTrash.projectId, projectId)];
  if (opts.before) conds.push(lt(entriesTrash.deletedAt, new Date(opts.before)));

  const found = await db
    .select({
      id: entriesTrash.id,
      collection: sql<string>`(SELECT name FROM collections WHERE id = ${entriesTrash.collectionId})`,
      data: entriesTrash.data,
      deletedAt: entriesTrash.deletedAt,
      deletedBy: entriesTrash.deletedBy,
    })
    .from(entriesTrash)
    .where(and(...conds))
    .orderBy(desc(entriesTrash.deletedAt))
    .limit(limit + 1);

  const hasMore = found.length > limit;
  const rows = found.slice(0, limit).map((r) => ({
    id: r.id,
    collection: r.collection,
    data: r.data,
    deletedAt: (r.deletedAt as Date).toISOString(),
    deletedBy: r.deletedBy,
  }));
  return { rows, hasMore };
}

/** Count entries (live + trashed, excluding the row itself) that reference an id. */
async function countInboundRefs(projectId: string, id: string): Promise<number> {
  const like = "%" + id + "%";
  const [live] = await db
    .select({ n: sql<number>`count(*)` })
    .from(entries)
    .where(and(eq(entries.projectId, projectId), sql`${entries.data}::text LIKE ${like}`));
  const [trash] = await db
    .select({ n: sql<number>`count(*)` })
    .from(entriesTrash)
    .where(
      and(
        eq(entriesTrash.projectId, projectId),
        sql`${entriesTrash.id} <> ${id}`,
        sql`${entriesTrash.data}::text LIKE ${like}`,
      ),
    );
  return Number(live.n) + Number(trash.n);
}

/** Asset ids in a row that no OTHER live-or-trashed entry references — freed by purge. */
async function computeAssetsFreed(
  projectId: string,
  collection: Collection,
  rowId: string,
  data: Record<string, unknown>,
): Promise<string[]> {
  const assetIds = collection.fields
    .filter((f) => f.type === "asset")
    .map((f) => data[f.name])
    .filter((v): v is string => typeof v === "string");
  const freed: string[] = [];
  for (const assetId of assetIds) {
    const like = "%" + assetId + "%";
    const [live] = await db
      .select({ n: sql<number>`count(*)` })
      .from(entries)
      .where(and(eq(entries.projectId, projectId), sql`${entries.data}::text LIKE ${like}`));
    const [trash] = await db
      .select({ n: sql<number>`count(*)` })
      .from(entriesTrash)
      .where(
        and(
          eq(entriesTrash.projectId, projectId),
          sql`${entriesTrash.id} <> ${rowId}`,
          sql`${entriesTrash.data}::text LIKE ${like}`,
        ),
      );
    if (Number(live.n) + Number(trash.n) === 0) freed.push(assetId);
  }
  return freed;
}

export interface PurgePlan {
  id: string;
  collection: string;
  inboundRefCount: number;
  assetsFreed: string[];
}

export type PurgeResult =
  | { purged: true; id: string }
  | { purged: false; requiresConfirmation: true; plan: PurgePlan; hint: string };

/**
 * Permanently remove one trashed entry. Terraform-style: without confirm it
 * returns a plan (inbound references that would dangle, assets that become
 * deletable); with confirm it deletes and audits 'purge'.
 */
export async function purgeEntry(
  projectId: string,
  collection: Collection,
  id: string,
  opts: { confirm?: boolean; actor?: AuditActor } = {},
): Promise<PurgeResult> {
  const [trashed] = await db
    .select()
    .from(entriesTrash)
    .where(and(eq(entriesTrash.id, id), eq(entriesTrash.collectionId, collection.id)))
    .limit(1);
  if (!trashed) throw new ValidationError(`no trashed entry ${id} in "${collection.name}"`, "E_NOT_FOUND");

  if (!opts.confirm) {
    const [inboundRefCount, assetsFreed] = await Promise.all([
      countInboundRefs(projectId, id),
      computeAssetsFreed(projectId, collection, id, trashed.data),
    ]);
    return {
      purged: false,
      requiresConfirmation: true,
      plan: { id, collection: collection.name, inboundRefCount, assetsFreed },
      hint: "permanent removal — re-run with confirm:true (restore will no longer be possible)",
    };
  }

  // Purge the row and reap its version history in one statement.
  await db.execute(sql`
    WITH purged AS (
      DELETE FROM ${entriesTrash}
      WHERE ${entriesTrash.id} = ${id} AND ${entriesTrash.collectionId} = ${collection.id}
      RETURNING id
    )
    DELETE FROM ${entryVersions} WHERE ${entryVersions.entryId} IN (SELECT id FROM purged)
  `);
  recordAudit({
    projectId,
    collectionName: collection.name,
    entryId: id,
    action: "purge",
    actor: opts.actor ?? UNKNOWN_ACTOR,
  });
  return { purged: true, id };
}

export type EmptyTrashResult =
  | { emptied: true; purged: number }
  | { emptied: false; requiresConfirmation: true; plan: { count: number; collection?: string }; hint: string };

/**
 * Permanently remove ALL trashed entries (optionally scoped to one collection).
 * Plan + confirm, like purge_entry.
 */
export async function emptyTrash(
  projectId: string,
  opts: { collection?: Collection; confirm?: boolean; actor?: AuditActor } = {},
): Promise<EmptyTrashResult> {
  const scope = opts.collection
    ? and(eq(entriesTrash.projectId, projectId), eq(entriesTrash.collectionId, opts.collection.id))
    : eq(entriesTrash.projectId, projectId);

  if (!opts.confirm) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(entriesTrash).where(scope);
    return {
      emptied: false,
      requiresConfirmation: true,
      plan: { count: Number(n), collection: opts.collection?.name },
      hint: "permanent removal of all trashed rows — re-run with confirm:true",
    };
  }

  // Delete the trash rows AND reap their version history in ONE statement —
  // atomic on neon-http, and no unbounded IN-list that could blow the bind-param
  // limit on a very large trash (the sibling idiom used by purgeEntry/sweep).
  const scopeSql = opts.collection
    ? sql`${entriesTrash.projectId} = ${projectId} AND ${entriesTrash.collectionId} = ${opts.collection.id}`
    : sql`${entriesTrash.projectId} = ${projectId}`;
  const result = await db.execute(sql`
    WITH purged AS (
      DELETE FROM ${entriesTrash} WHERE ${scopeSql} RETURNING id
    ),
    reaped AS (
      DELETE FROM ${entryVersions} WHERE ${entryVersions.entryId} IN (SELECT id FROM purged)
    )
    SELECT id FROM purged
  `);
  const rows = ((result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as {
    id: string;
  }[];
  for (const r of rows) {
    recordAudit({
      projectId,
      collectionName: opts.collection?.name ?? "(various)",
      entryId: r.id,
      action: "purge",
      actor: opts.actor ?? UNKNOWN_ACTOR,
    });
  }
  return { emptied: true, purged: rows.length };
}
