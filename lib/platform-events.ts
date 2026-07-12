import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { controlDb } from "@/db";
import { platformEvents, projects, type PlatformEventRow, type PlatformEventType } from "@/db/schema";
import { defer } from "./defer";

/**
 * Platform-operator action trail (B4): suspend/unsuspend + support access.
 * Control-plane by design — the tenant can READ their project's trail (that
 * visibility is the support-access policy, decision #6) but never write or
 * erase it. Recording is deferred and swallowed: the trail must never take
 * down the surface that triggered it.
 */

export function recordPlatformEvent(opts: {
  projectId: string;
  projectName: string;
  type: PlatformEventType;
  actorEmail: string;
  note?: string | null;
}): void {
  defer(async () => {
    await controlDb
      .insert(platformEvents)
      .values({
        projectId: opts.projectId,
        projectName: opts.projectName,
        type: opts.type,
        actorEmail: opts.actorEmail,
        note: opts.note ?? null,
      })
      .catch(() => {});
  });
}

/**
 * Support access (decision #6, settled 2026-07-11): a platform operator
 * opening a project they have no workspace/member rung into is allowed, but
 * every such visit is logged and tenant-visible. The project layout calls
 * this on every render — dedupe to one row per operator+project per window so
 * a support session reads as one visit, not forty page loads.
 */
const SUPPORT_ACCESS_DEDUPE_MS = 12 * 60 * 60 * 1000;

export async function recordSupportAccess(projectId: string, actorEmail: string): Promise<void> {
  const since = new Date(Date.now() - SUPPORT_ACCESS_DEDUPE_MS);
  const [recent] = await controlDb
    .select({ id: platformEvents.id })
    .from(platformEvents)
    .where(
      and(
        eq(platformEvents.projectId, projectId),
        eq(platformEvents.type, "support_access"),
        eq(platformEvents.actorEmail, actorEmail),
        gt(platformEvents.createdAt, since),
      ),
    )
    .limit(1);
  if (recent) return;
  const [project] = await controlDb
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  recordPlatformEvent({
    projectId,
    projectName: project?.name ?? projectId,
    type: "support_access",
    actorEmail,
  });
}

/** Newest-first trail for one project — the tenant-visible Settings section. */
export async function listProjectPlatformEvents(projectId: string, limit = 20): Promise<PlatformEventRow[]> {
  return controlDb
    .select()
    .from(platformEvents)
    .where(eq(platformEvents.projectId, projectId))
    .orderBy(desc(platformEvents.createdAt))
    .limit(limit);
}

/** The reason on the most recent suspend — for the tenant-facing banner. */
export async function latestSuspendNote(projectId: string): Promise<string | null> {
  const [row] = await controlDb
    .select({ note: platformEvents.note })
    .from(platformEvents)
    .where(and(eq(platformEvents.projectId, projectId), eq(platformEvents.type, "suspend")))
    .orderBy(desc(platformEvents.createdAt))
    .limit(1);
  return row?.note ?? null;
}
