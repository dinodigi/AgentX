import { and, desc, eq, sql } from "drizzle-orm";
import { tenantDb } from "./data-plane";
import { auditLog, type AuditActor, type AuditLogRow } from "@/db/schema";
import { defer } from "./defer";

/** 0c: audit rows previously had NO retention (grew unbounded — a top storage
 * amplifier in the free-tier wedge report). Probabilistic on-write prune,
 * mirroring the change-feed's pattern: ~1% of writes delete a bounded batch of
 * rows older than the retention window. */
const AUDIT_RETENTION_DAYS = 90;
const PRUNE_PROBABILITY = 0.01;
const PRUNE_BATCH = 500;

/**
 * Light audit trail: one row per entry mutation, recording which surface
 * (mcp/admin/delivery) did it and as whom. Fire-and-forget by contract —
 * auditing must never take down the mutation path — but deferred via after()
 * so serverless freeze can't drop the row.
 */
export type AuditAction = "create" | "update" | "delete" | "restore" | "purge";

export function recordAudit(opts: {
  projectId: string;
  collectionName: string;
  entryId: string;
  action: AuditAction;
  actor: AuditActor;
  changedFields?: string[];
}): void {
  defer(async () => {
    const tdb = await tenantDb(opts.projectId);
    await tdb
      .insert(auditLog)
      .values({
        projectId: opts.projectId,
        collectionName: opts.collectionName,
        entryId: opts.entryId,
        action: opts.action,
        actor: opts.actor,
        changedFields: opts.changedFields ?? null,
      })
      .catch(() => {});
    if (Math.random() < PRUNE_PROBABILITY) {
      await tdb
        .execute(
          sql`DELETE FROM audit_log WHERE ctid IN (
                SELECT ctid FROM audit_log
                WHERE project_id = ${opts.projectId}
                  AND created_at < now() - interval '${sql.raw(String(AUDIT_RETENTION_DAYS))} days'
                LIMIT ${PRUNE_BATCH})`,
        )
        .catch(() => {});
    }
  });
}

export interface AuditFilter {
  collectionName?: string;
  entryId?: string;
  action?: AuditAction;
  limit: number;
  offset: number;
}

/** Newest-first page of the audit trail, limit+1 probe row included. */
export async function listAuditLog(
  projectId: string,
  f: AuditFilter,
): Promise<AuditLogRow[]> {
  const conditions = [eq(auditLog.projectId, projectId)];
  if (f.collectionName) conditions.push(eq(auditLog.collectionName, f.collectionName));
  if (f.entryId) conditions.push(eq(auditLog.entryId, f.entryId));
  if (f.action) conditions.push(eq(auditLog.action, f.action));
  return (await tenantDb(projectId))
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(f.limit + 1)
    .offset(f.offset);
}
