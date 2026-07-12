"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getViewer } from "@/lib/access";
import { recordPlatformEvent } from "@/lib/platform-events";

/**
 * Operator console mutations (B4). Platform-operator only — these act ACROSS
 * tenants, so the gate is the viewer's platform role, not a project role.
 * Every action lands in platform_events (the tenant-visible trail).
 */

/**
 * The abuse lever: MCP + delivery go dark immediately (token cache
 * revalidated), the tenant admin stays reachable with a banner carrying the
 * reason. Only from 'active' — a setup project has nothing to darken, and
 * unsuspending must return the project to the state suspend took it from.
 */
export async function suspendProjectAction(
  projectId: string,
  reason: string,
): Promise<{ error?: string; ok?: boolean }> {
  const viewer = await getViewer();
  if (!viewer?.isPlatformOperator) return { error: "Platform operators only" };
  const note = reason.trim();
  if (!note) return { error: "A reason is required — the tenant sees it on the suspension banner" };

  const [project] = await db
    .select({ name: projects.name, status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return { error: "Project not found" };
  if (project.status === "suspended") return { ok: true };
  if (project.status !== "active") {
    return { error: "Only active projects can be suspended (setup projects are already dark)" };
  }

  await db.update(projects).set({ status: "suspended" }).where(eq(projects.id, projectId));
  recordPlatformEvent({
    projectId,
    projectName: project.name,
    type: "suspend",
    actorEmail: viewer.email,
    note,
  });
  revalidateTag("project-tokens"); // dark NOW, not in 5 minutes
  revalidateTag(`project:${projectId}`);
  revalidatePath("/admin/console");
  revalidatePath(`/admin/${projectId}`, "layout");
  return { ok: true };
}

export async function unsuspendProjectAction(projectId: string): Promise<{ error?: string; ok?: boolean }> {
  const viewer = await getViewer();
  if (!viewer?.isPlatformOperator) return { error: "Platform operators only" };

  const [project] = await db
    .select({ name: projects.name, status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return { error: "Project not found" };
  if (project.status !== "suspended") return { ok: true };

  await db.update(projects).set({ status: "active" }).where(eq(projects.id, projectId));
  recordPlatformEvent({
    projectId,
    projectName: project.name,
    type: "unsuspend",
    actorEmail: viewer.email,
  });
  revalidateTag("project-tokens");
  revalidateTag(`project:${projectId}`);
  revalidatePath("/admin/console");
  revalidatePath(`/admin/${projectId}`, "layout");
  return { ok: true };
}
