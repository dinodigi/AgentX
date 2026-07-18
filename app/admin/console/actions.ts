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

/** Platform Settings: caps overrides + metered rates, operator-edited (no env). */
export async function savePlatformSettingsAction(input: {
  capsSandbox: Record<string, number>;
  capsPaid: Record<string, number>;
  meteredRates: { computeCentsPerCuHour: number; storageCentsPerGbMonth: number } | null;
}): Promise<{ error?: string; ok?: boolean }> {
  const viewer = await getViewer();
  if (!viewer?.isPlatformOperator) return { error: "Platform operators only" };
  const { setSetting, deleteSetting } = await import("@/lib/platform-settings");

  const cleanCaps = (o: Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const k of ["entries", "collections", "assetBytes", "dataBytes"]) {
      const v = Number(o[k]);
      if (Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    return out;
  };
  await setSetting("caps.sandbox", cleanCaps(input.capsSandbox));
  await setSetting("caps.paid", cleanCaps(input.capsPaid));

  if (input.meteredRates) {
    const compute = Number(input.meteredRates.computeCentsPerCuHour);
    const storage = Number(input.meteredRates.storageCentsPerGbMonth);
    if (!Number.isFinite(compute) || compute < 0 || !Number.isFinite(storage) || storage < 0) {
      return { error: "Metered rates must be non-negative numbers (cents)" };
    }
    await setSetting("meteredRates", { computeCentsPerCuHour: compute, storageCentsPerGbMonth: storage });
  } else {
    // null = metering OFF (unless the METERED_RATES env is set as a fallback)
    await deleteSetting("meteredRates");
  }
  // (platform_events is project-scoped; settings edits are traceable via
  // platform_settings.updated_at)
  revalidatePath("/admin/console/settings");
  revalidatePath("/admin/console");
  return { ok: true };
}

/** Feedback wall: move an item through new → reviewed/planned/done/dismissed. */
export async function setFeedbackStatusAction(
  id: string,
  status: "new" | "reviewed" | "planned" | "done" | "dismissed",
): Promise<{ error?: string; ok?: boolean }> {
  const viewer = await getViewer();
  if (!viewer?.isPlatformOperator) return { error: "Platform operators only" };
  const { platformFeedback } = await import("@/db/schema");
  await db.update(platformFeedback).set({ status }).where(eq(platformFeedback.id, id));
  revalidatePath("/admin/console/feedback");
  return { ok: true };
}

/** Bulk-resolve every OPEN feedback item in one category (or all). */
export async function bulkResolveFeedbackAction(
  category: string | "all",
  status: "done" | "dismissed",
): Promise<{ error?: string; ok?: boolean; count?: number }> {
  const viewer = await getViewer();
  if (!viewer?.isPlatformOperator) return { error: "Platform operators only" };
  const { platformFeedback } = await import("@/db/schema");
  const { inArray, and, eq: eqCol } = await import("drizzle-orm");
  const open = inArray(platformFeedback.status, ["new", "reviewed", "planned"]);
  const where = category === "all" ? open : and(open, eqCol(platformFeedback.category, category));
  const rows = await db.update(platformFeedback).set({ status }).where(where).returning({ id: platformFeedback.id });
  revalidatePath("/admin/console/feedback");
  return { ok: true, count: rows.length };
}

/** Plugin management: fleet-wide activate/deactivate + display price. */
export async function savePluginOverrideAction(
  id: string,
  override: { active?: boolean; priceCents?: number | null },
): Promise<{ error?: string; ok?: boolean }> {
  const viewer = await getViewer();
  if (!viewer?.isPlatformOperator) return { error: "Platform operators only" };
  if (override.priceCents != null && (!Number.isFinite(override.priceCents) || override.priceCents < 0)) {
    return { error: "Price must be a non-negative number of cents" };
  }
  const { savePluginOverride } = await import("@/lib/plugins");
  await savePluginOverride(id, override);
  revalidatePath("/admin/console/plugins");
  return { ok: true };
}
