"use server";

import { clerkClient } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { workspaces, workspaceMembers } from "@/db/schema";
import { getViewer } from "@/lib/access";
import { getWorkspaceRole } from "@/lib/workspaces";

/**
 * Workspace member management (B1b). Owner + admin manage membership; a manager
 * works in the projects but can't change the team. Platform operators can manage
 * any workspace. Mirrors the per-project member flow, incl. its limitation: the
 * invitee must already have a Clerk account (no pending-invite flow yet).
 */

type Result = { error?: string };

/** Gate: platform operator, or owner/admin of THIS workspace. */
async function requireManager(workspaceId: string): Promise<{ userId: string } | { error: string }> {
  const viewer = await getViewer();
  if (!viewer) return { error: "not signed in" };
  if (viewer.isPlatformOperator) return { userId: viewer.userId };
  const role = await getWorkspaceRole(workspaceId, viewer.userId);
  if (role === "owner" || role === "admin") return { userId: viewer.userId };
  return { error: "Only workspace owners and admins can manage the team" };
}

export async function addWorkspaceMember(workspaceId: string, formData: FormData): Promise<Result> {
  const gate = await requireManager(workspaceId);
  if ("error" in gate) return gate;

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "manager");
  if (!email) return { error: "Enter an email" };
  if (role !== "admin" && role !== "manager") return { error: "Invalid role" };

  const client = await clerkClient();
  const users = await client.users.getUserList({ emailAddress: [email] });
  const user = users.data[0];
  if (!user) return { error: "No Clerk user with that email — they need to sign up first" };

  await db
    .insert(workspaceMembers)
    .values({ workspaceId, clerkUserId: user.id, email, role })
    .onConflictDoNothing();
  revalidatePath("/admin/workspace");
  return {};
}

export async function removeWorkspaceMember(workspaceId: string, memberId: string): Promise<Result> {
  const gate = await requireManager(workspaceId);
  if ("error" in gate) return gate;

  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId)))
    .limit(1);
  if (!member) return { error: "Member not found" };
  if (member.role === "owner") return { error: "The workspace owner can't be removed" };

  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId)));
  revalidatePath("/admin/workspace");
  return {};
}

export async function renameWorkspace(workspaceId: string, formData: FormData): Promise<Result> {
  // Rename is owner-only (a notch above manage).
  const viewer = await getViewer();
  if (!viewer) return { error: "not signed in" };
  const role = viewer.isPlatformOperator ? "owner" : await getWorkspaceRole(workspaceId, viewer.userId);
  if (role !== "owner") return { error: "Only the workspace owner can rename it" };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Enter a workspace name" };
  await db.update(workspaces).set({ name }).where(eq(workspaces.id, workspaceId));
  revalidatePath("/admin/workspace");
  return {};
}
