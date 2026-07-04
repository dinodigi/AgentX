"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { clerkClient } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, projectTokens, projectMembers } from "@/db/schema";
import { generateToken, hashToken } from "@/lib/tokens";
import { getProjectRole } from "@/lib/access";
import { updateCollectionSettings } from "@/lib/collections";

/** Settings mutations. All require the operator role on the project. */

async function requireOperator(projectId: string): Promise<string | null> {
  const role = await getProjectRole(projectId);
  return role === "operator" ? null : "You need the operator role for this";
}

export async function updateBranding(
  projectId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };

  const displayName = String(formData.get("displayName") ?? "").trim();
  const primaryColor = String(formData.get("primaryColor") ?? "").trim();
  const logoUrl = String(formData.get("logoUrl") ?? "").trim();
  if (!displayName) return { error: "Enter a display name" };
  if (!/^#[0-9a-fA-F]{6}$/.test(primaryColor)) return { error: "Pick a valid color" };

  await db
    .update(projects)
    .set({ branding: { displayName, primaryColor, logoUrl: logoUrl || undefined } })
    .where(eq(projects.id, projectId));
  revalidateTag(`project:${projectId}`);
  revalidatePath(`/admin/${projectId}`, "layout");
  return {};
}

export async function mintToken(
  projectId: string,
  label: string,
): Promise<{ error?: string; token?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };

  const raw = generateToken();
  await db.insert(projectTokens).values({
    projectId,
    tokenHash: hashToken(raw),
    scope: "mcp",
    label: label.trim() || null,
  });
  revalidatePath(`/admin/${projectId}/settings`);
  return { token: raw };
}

export async function revokeToken(
  projectId: string,
  tokenId: string,
): Promise<{ error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };

  await db
    .delete(projectTokens)
    .where(and(eq(projectTokens.id, tokenId), eq(projectTokens.projectId, projectId)));
  // Token→project resolution is cached; drop it so revoked tokens die now.
  revalidateTag("project-tokens");
  revalidatePath(`/admin/${projectId}/settings`);
  return {};
}

export async function updateWebhook(
  projectId: string,
  collectionName: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };

  const url = String(formData.get("webhookUrl") ?? "").trim();
  if (url && !/^https?:\/\//.test(url)) return { error: "Webhook must be an http(s) URL" };
  await updateCollectionSettings(projectId, collectionName, { webhookUrl: url || null });
  revalidatePath(`/admin/${projectId}/settings`);
  return {};
}

export async function addMember(
  projectId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "client");
  if (!email) return { error: "Enter an email" };
  if (role !== "operator" && role !== "client") return { error: "Invalid role" };

  const client = await clerkClient();
  const users = await client.users.getUserList({ emailAddress: [email] });
  const user = users.data[0];
  if (!user) {
    return { error: "No Clerk user with that email — they need to sign up first" };
  }

  await db
    .insert(projectMembers)
    .values({ projectId, clerkUserId: user.id, email, role })
    .onConflictDoNothing();
  revalidatePath(`/admin/${projectId}/settings`);
  return {};
}

export async function removeMember(
  projectId: string,
  memberId: string,
): Promise<{ error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };

  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)));
  revalidatePath(`/admin/${projectId}/settings`);
  return {};
}
