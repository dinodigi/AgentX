"use server";

import { randomBytes } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, projectTokens } from "@/db/schema";
import { generateToken, hashToken } from "@/lib/tokens";
import { getViewer } from "@/lib/access";
import { getActiveWorkspace } from "@/lib/workspaces";

export interface CreateProjectResult {
  error?: string;
  projectId?: string;
  token?: string;
  /** 'active' (sandbox — usable immediately) or 'setup' (paid — pick a plane). */
  status?: "setup" | "active";
}

/**
 * Create a project in the viewer's ACTIVE workspace (B1c) — workspace
 * ownership grants operator access via the access ladder, so no
 * project_members row is needed. The MCP token is returned ONCE for the
 * reveal screen; only its hash is stored.
 *
 * B2 lifecycle: `plan` picks the path.
 * - sandbox — SELF-SERVE for workspace owners/admins, ONE per workspace, on
 *   the shared plane with hard caps (the free tier decided 2026-07-11), live
 *   immediately (status 'active').
 * - byo | managed — lands in status 'setup' (pick + provision a data plane on
 *   the setup screen, then activate). Creation stays operator-only until B3
 *   attaches billing to this exact seam.
 */
export async function createProject(formData: FormData): Promise<CreateProjectResult> {
  const viewer = await getViewer();
  if (!viewer) return { error: "not signed in" };

  const name = String(formData.get("name") ?? "").trim();
  const color = String(formData.get("color") ?? "#4f46e5");
  const plan = String(formData.get("plan") ?? "sandbox");
  if (!name) return { error: "Enter a project name" };
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { error: "Pick a valid color" };
  if (!["sandbox", "byo", "managed"].includes(plan)) return { error: "Pick a plan" };

  const workspace = await getActiveWorkspace(viewer);
  if (workspace.role !== "owner" && workspace.role !== "admin" && !viewer.isPlatformOperator) {
    return { error: "Only workspace owners and admins can create projects here" };
  }

  if (plan === "sandbox") {
    const [existing] = await db
      .select({ n: count() })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspace.id), eq(projects.plan, "sandbox")));
    if ((existing?.n ?? 0) >= 1) {
      return { error: "This workspace already has its free sandbox — upgrade it or create a paid project." };
    }
  }

  let project;
  try {
    [project] = await db
      .insert(projects)
      .values({
        name,
        workspaceId: workspace.id,
        branding: { displayName: name, primaryColor: color },
        webhookSigningSecret: randomBytes(32).toString("hex"),
        plan: plan as "sandbox" | "byo" | "managed",
        // Sandbox lives on the shared plane — nothing to set up; paid picks a
        // data plane on the setup screen (B2) and subscribes there (B3) before
        // the agent surfaces light up.
        status: plan === "sandbox" ? "active" : "setup",
        // Operator-created paid projects (ours/dogfood/support) skip billing.
        billingExempt: plan !== "sandbox" && viewer.isPlatformOperator,
      })
      .returning();
  } catch (e) {
    // The partial unique index (C4) is the real one-sandbox gate — the count
    // check above is just the friendly fast path and is raceable.
    if (plan === "sandbox" && e instanceof Error && /projects_one_sandbox_per_ws_idx|duplicate key/.test(e.message)) {
      return { error: "This workspace already has its free sandbox — upgrade it or create a paid project." };
    }
    throw e;
  }

  const raw = generateToken();
  await db.insert(projectTokens).values({
    projectId: project.id,
    tokenHash: hashToken(raw),
    scope: "mcp",
    label: "created with project",
  });

  // A freshly created project is never 'suspended' — narrow for the reveal UI.
  return { projectId: project.id, token: raw, status: project.status as "setup" | "active" };
}
