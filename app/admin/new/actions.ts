"use server";

import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { projects, projectTokens, projectMembers } from "@/db/schema";
import { generateToken, hashToken } from "@/lib/tokens";
import { getViewer } from "@/lib/access";

export interface CreateProjectResult {
  error?: string;
  projectId?: string;
  token?: string;
}

/**
 * Create a project from the admin UI (replaces the seed script). The creator
 * becomes its operator member; the MCP token is returned ONCE for the reveal
 * screen and only its hash is stored.
 */
export async function createProject(formData: FormData): Promise<CreateProjectResult> {
  const viewer = await getViewer();
  if (!viewer) return { error: "not signed in" };
  // LAUNCH-PLAN 0.1: creation is invite-only until the workspace + billing
  // layer (B2) reopens it self-serve. The UI hides its affordances too, but
  // this check is the one that holds.
  if (!viewer.isPlatformOperator) {
    return { error: "Project creation is invite-only during the beta." };
  }

  const name = String(formData.get("name") ?? "").trim();
  const color = String(formData.get("color") ?? "#4f46e5");
  if (!name) return { error: "Enter a project name" };
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { error: "Pick a valid color" };

  const [project] = await db
    .insert(projects)
    .values({
      name,
      branding: { displayName: name, primaryColor: color },
      webhookSigningSecret: randomBytes(32).toString("hex"),
    })
    .returning();

  const raw = generateToken();
  await Promise.all([
    db.insert(projectTokens).values({
      projectId: project.id,
      tokenHash: hashToken(raw),
      scope: "mcp",
      label: "created with project",
    }),
    db.insert(projectMembers).values({
      projectId: project.id,
      clerkUserId: viewer.userId,
      email: viewer.email,
      role: "operator",
    }),
  ]);

  return { projectId: project.id, token: raw };
}
