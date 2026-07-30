import { and, eq, desc, sql } from "drizzle-orm";
import { tenantDb } from "./data-plane";
import { entryVersions, type AuditActor, type Collection } from "@/db/schema";
import { defer } from "./defer";
import { redact } from "./write-only";
import type { FieldDef } from "./field-types";

/**
 * Entry version history — PRE-image snapshots captured on update. Kept lean:
 * recordVersion writes and prunes (last 20 per entry) fire-and-forget, exactly
 * like recordAudit. listEntryVersions pages newest-first. The point-in-time
 * RESTORE lives in lib/entries.ts (it needs the write pipeline); this module
 * has no dependency on entries.ts, so entries.ts can import recordVersion here
 * without a cycle.
 *
 * SEC-1: recordVersion takes the whole COLLECTION rather than a collectionId
 * precisely so it can strip write-only fields from the snapshot itself — a
 * secret is never copied into version history. Passing the collection is what
 * makes that structural instead of a rule four call sites have to remember.
 */

const MAX_VERSIONS_PER_ENTRY = 20;

export function recordVersion(opts: {
  projectId: string;
  collection: Collection;
  entryId: string;
  /** The entry's data BEFORE this update. */
  data: Record<string, unknown>;
  changedFields?: string[];
  actor: AuditActor;
}): void {
  const stored = redact(opts.collection.fields as FieldDef[], opts.data);
  defer(async () => {
    try {
      const tdb = await tenantDb(opts.projectId);
      await tdb.insert(entryVersions).values({
        projectId: opts.projectId,
        collectionId: opts.collection.id,
        entryId: opts.entryId,
        data: stored,
        changedFields: opts.changedFields ?? null,
        actor: opts.actor,
      });
      // Keep only the most recent N snapshots for this entry.
      await tdb.execute(sql`
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

/**
 * Newest-first page of an entry's version history (project + entry scoped).
 *
 * SEC-1: `fields` is REQUIRED (not an optional knob) so a caller cannot read
 * history without declaring the schema it is reading it under. New snapshots
 * were already stripped at write time, but a field FLIPPED to write-only leaves
 * plaintext in snapshots taken before the flip — this is the pass that catches
 * those.
 */
export async function listEntryVersions(
  projectId: string,
  entryId: string,
  fields: FieldDef[],
  opts: { limit?: number; offset?: number } = {},
): Promise<{ versions: VersionRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const found = await (await tenantDb(projectId))
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
    data: redact(fields, v.data),
  }));
  return { versions, hasMore };
}
