import { db } from "@/db";
import { auditLog, type AuditActor } from "@/db/schema";

/**
 * Light audit trail: one row per entry mutation, recording which surface
 * (mcp/admin/delivery) did it and as whom. Fire-and-forget by contract —
 * auditing must never take down the mutation path.
 */
export function recordAudit(opts: {
  projectId: string;
  collectionName: string;
  entryId: string;
  action: "create" | "update" | "delete";
  actor: AuditActor;
  changedFields?: string[];
}): void {
  void db
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
}
