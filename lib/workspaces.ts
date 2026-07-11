import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, workspaces, workspaceMembers, type WorkspaceRole } from "@/db/schema";
import type { Viewer } from "./access";

export interface WorkspaceMemberRow {
  id: string;
  email: string;
  role: WorkspaceRole;
  clerkUserId: string;
}

/**
 * Workspace membership (B1). A workspace owns projects; a membership here
 * cascades to `operator` on every project the workspace owns (see lib/access).
 * This module is the write/lookup side; lib/access resolves effective access.
 */

/** Turn an email into a friendly default workspace name. */
export function workspaceName(email: string): string {
  const local = (email.split("@")[0] || "user").replace(/[._-]+/g, " ").trim();
  const titled = local ? local.charAt(0).toUpperCase() + local.slice(1) : "My";
  return `${titled}'s Workspace`;
}

/** The viewer's role in a workspace, or null if they don't belong. */
export async function getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.clerkUserId, userId)))
    .limit(1);
  return row ? (row.role as WorkspaceRole) : null;
}

/** A workspace's identity, or null if it doesn't exist. */
export async function getWorkspace(id: string): Promise<{ id: string; name: string } | null> {
  const [w] = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return w ?? null;
}

/** Members of a workspace, oldest first (the owner leads). */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberRow[]> {
  const rows = await db
    .select({
      id: workspaceMembers.id,
      email: workspaceMembers.email,
      role: workspaceMembers.role,
      clerkUserId: workspaceMembers.clerkUserId,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt));
  return rows as WorkspaceMemberRow[];
}

/**
 * Whether the viewer may delete/rename-lifecycle a project (B2). Stricter than
 * `operator` access: only a platform operator or the OWNING workspace's
 * owner/admin — never a project_members outsider share (B1: sharing never
 * spreads deletion).
 */
export async function canDeleteProject(projectId: string, viewer: Viewer): Promise<boolean> {
  if (viewer.isPlatformOperator) return true;
  const [p] = await db.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p?.workspaceId) return false;
  const role = await getWorkspaceRole(p.workspaceId, viewer.userId);
  return role === "owner" || role === "admin";
}

/** Workspace ids the viewer belongs to (any role). */
export async function workspaceIdsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.clerkUserId, userId));
  return rows.map((r) => r.id);
}

/**
 * The viewer's personal workspace — the one they own — creating it on first
 * need. This is where a new project lands (the sign-up → workspace step); a user
 * owns exactly one personal workspace and may also belong to others.
 */
export async function ensurePersonalWorkspace(viewer: Viewer): Promise<string> {
  const [owned] = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.clerkUserId, viewer.userId), eq(workspaceMembers.role, "owner")))
    .limit(1);
  if (owned) return owned.id;

  const [ws] = await db
    .insert(workspaces)
    .values({ name: workspaceName(viewer.email) })
    .returning({ id: workspaces.id });
  await db.insert(workspaceMembers).values({
    workspaceId: ws.id,
    clerkUserId: viewer.userId,
    email: viewer.email,
    role: "owner",
  });
  return ws.id;
}
