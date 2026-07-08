import { and, eq, desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { entryVersions, type AuditActor } from "@/db/schema";
import { defer } from "./defer";

/**
 * Entry version history — PRE-image snapshots captured on update. Kept lean:
 * recordVersion writes and prunes (last 20 per entry) fire-and-forget, exactly
 * like recordAudit. listEntryVersions pages newest-first. The point-in-time
 * RESTORE lives in lib/entries.ts (it needs the write pipeline); this module
 * has no dependency on entries.ts, so entries.ts can import recordVersion here
 * without a cycle.
 */

const MAX_VERSIONS_PER_ENTRY = 20;

export function recordVersion(opts: {
  projectId: string;
  collectionId: string;
  entryId: string;
  /** The entry's data BEFORE this update. */
  data: Record<string, unknown>;
  changedFields?: string[];
  actor: AuditActor;
}): void {
  defer(async () => {
    try {
      await db.insert(entryVersions).values({
        projectId: opts.projectId,
        collectionId: opts.collectionId,
        entryId: opts.entryId,
        data: opts.data,
        changedFields: opts.changedFields ?? null,
        actor: opts.actor,
      });
      // Keep only the most recent N snapshots for this entry.
      await db.execute(sql`
        DELETE FROM ${entryVersions}
        WHERE ${entryVersions.entryId} = ${opts.entryId}
          AND id NOT IN (
            SELECT id FROM ${entryVersions}
            WHERE ${entryVersions.entryId} = ${opts.entryId}
            ORDER BY created_at DESC, id DESC
            LIMIT ${MAX_VERSIONS_PER_ENTRY}
          )
      `);
    } catch {
      // history is best-effort — never take down the mutation path
    }
  });
}

export interface VersionRow {
  versionId: string;
  createdAt: string;
  actor: AuditActor;
  changedFields: string[] | null;
  data: Record<string, unknown>;
}

/** Newest-first page of an entry's version history (project + entry scoped). */
export async function listEntryVersions(
  projectId: string,
  entryId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ versions: VersionRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const found = await db
    .select()
    .from(entryVersions)
    .where(and(eq(entryVersions.projectId, projectId), eq(entryVersions.entryId, entryId)))
    .orderBy(desc(entryVersions.createdAt), desc(entryVersions.id))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = found.length > limit;
  const versions = found.slice(0, limit).map((v) => ({
    versionId: v.id,
    createdAt: (v.createdAt as Date).toISOString(),
    actor: v.actor,
    changedFields: v.changedFields,
    data: v.data,
  }));
  return { versions, hasMore };
}
