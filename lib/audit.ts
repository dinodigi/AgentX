import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, type AuditActor, type AuditLogRow } from "@/db/schema";
import { defer } from "./defer";

/**
 * Light audit trail: one row per entry mutation, recording which surface
 * (mcp/admin/delivery) did it and as whom. Fire-and-forget by contract —
 * auditing must never take down the mutation path — but deferred via after()
 * so serverless freeze can't drop the row.
 */
export function recordAudit(opts: {
  projectId: string;
  collectionName: string;
  entryId: string;
  action: "create" | "update" | "delete";
  actor: AuditActor;
  changedFields?: string[];
}): void {
  defer(() =>
    db
      .insert(auditLog)
      .values({
        projectId: opts.projectId,
        collectionName: opts.collectionName,
        entryId: opts.entryId,
        action: opts.action,
        actor: opts.actor,
        changedFields: opts.changedFields ?? null,
      })
      .catch(() => {}),
  );
}

export interface AuditFilter {
  collectionName?: string;
  entryId?: string;
  action?: "create" | "update" | "delete";
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
  return db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(f.limit + 1)
    .offset(f.offset);
}
