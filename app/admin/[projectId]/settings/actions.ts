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

/** Rotate a connector secret — the new key is validated BEFORE the old one is replaced. */
export async function rotateConnectorSecretAction(
  projectId: string,
  type: "clerk" | "resend" | "stripe",
  newSecret: string,
): Promise<{ ok: boolean; detail: string; error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { ok: false, detail: "", error: denied };
  const { rotateConnectorSecret } = await import("@/lib/connectors");
  const res = await rotateConnectorSecret(projectId, type, newSecret);
  revalidatePath(`/admin/${projectId}/connectors`);
  return res;
}

/** Replay a failed delivery from the log; the outcome lands as a new row. */
export async function refireDeliveryAction(
  projectId: string,
  deliveryId: string,
): Promise<void> {
  const role = await getProjectRole(projectId);
  if (!role) return;
  const { refireDelivery } = await import("@/lib/events");
  try {
    await refireDelivery(projectId, deliveryId);
  } catch {
    // Outcome (or the miss) is visible in the log itself.
  }
  revalidatePath(`/admin/${projectId}/settings`);
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
  scope: "mcp" | "delivery" = "mcp",
): Promise<{ error?: string; token?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  if (scope !== "mcp" && scope !== "delivery") return { error: "invalid scope" };

  const raw = generateToken();
  await db.insert(projectTokens).values({
    projectId,
    tokenHash: hashToken(raw),
    scope,
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

export async function saveConnector(
  projectId: string,
  type: "clerk" | "resend" | "stripe",
  formData: FormData,
): Promise<{ error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };

  const { CONNECTOR_SPECS, upsertConnector, deriveClerkIssuer } = await import("@/lib/connectors");
  const spec = CONNECTOR_SPECS[type];
  const config: Record<string, string> = {};
  for (const f of spec.configFields) {
    config[f.key] = String(formData.get(f.key) ?? "").trim();
  }
  if (type === "clerk") {
    // One-paste connect: the publishable key alone is enough — derive the issuer.
    if (!config.issuer && config.publishableKey) {
      const derived = deriveClerkIssuer(config.publishableKey);
      if (!derived) {
        return { error: "Couldn't read that publishable key — it should start with pk_test_ or pk_live_" };
      }
      config.issuer = derived;
    }
    if (!config.issuer) {
      return { error: "Paste your Clerk publishable key (or an issuer URL)" };
    }
    if (!/^https:\/\//.test(config.issuer)) {
      return { error: "Issuer must be an https URL" };
    }
    // Validate before saving: a connector that never worked shouldn't say "connected".
    try {
      const res = await fetch(`${config.issuer.replace(/\/$/, "")}/.well-known/jwks.json`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return { error: `That instance's JWKS returned HTTP ${res.status} — check the key/issuer` };
      }
    } catch {
      return { error: "Couldn't reach that Clerk instance — check the key/issuer and try again" };
    }
  }
  if (type === "stripe" && config.publishableKey && !/^pk_(test|live)_/.test(config.publishableKey)) {
    return { error: "Publishable key should start with pk_test_ or pk_live_" };
  }
  const secret = String(formData.get("secret") ?? "").trim();
  if (spec.secretLabel && !secret) {
    const { getConnector } = await import("@/lib/connectors");
    const existing = await getConnector(projectId, type);
    if (!existing?.secretEnc) return { error: `${spec.secretLabel} is required` };
  }
  if (type === "stripe" && secret && !/^(sk|rk)_(test|live)_/.test(secret)) {
    return { error: "Secret key should start with sk_test_ or sk_live_ (or a restricted rk_ key)" };
  }
  // Named secret slots (e.g. stripe webhookSigning) — blank keeps the stored one.
  const extraSecrets: Record<string, string> = {};
  for (const extra of spec.extraSecrets ?? []) {
    const v = String(formData.get(`secret:${extra.slot}`) ?? "").trim();
    if (v) extraSecrets[extra.slot] = v;
  }
  if (extraSecrets.webhookSigning && !/^whsec_/.test(extraSecrets.webhookSigning)) {
    return { error: "Webhook signing secret should start with whsec_" };
  }
  await upsertConnector(
    projectId,
    type,
    config,
    secret || undefined,
    Object.keys(extraSecrets).length ? extraSecrets : undefined,
  );
  revalidatePath(`/admin/${projectId}/connectors`);
  return {};
}

export async function disconnectConnector(
  projectId: string,
  type: "clerk" | "resend" | "stripe",
): Promise<{ error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  const { removeConnector } = await import("@/lib/connectors");
  await removeConnector(projectId, type);
  revalidatePath(`/admin/${projectId}/connectors`);
  return {};
}

export async function testConnector(
  projectId: string,
  type: "clerk" | "resend" | "stripe",
): Promise<{ error?: string; ok?: boolean; detail?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  const { checkConnectorHealth } = await import("@/lib/connectors");
  const result = await checkConnectorHealth(projectId, type);
  revalidatePath(`/admin/${projectId}/connectors`);
  return result;
}

/** Cancel a pending background job (Automation section). */
export async function cancelJobAction(projectId: string, jobId: string): Promise<void> {
  const denied = await requireOperator(projectId);
  if (denied) return;
  const { cancelJob } = await import("@/lib/jobs");
  await cancelJob(projectId, jobId); // not-pending is a no-op — the list shows the live status
  revalidatePath(`/admin/${projectId}/settings`);
}

/** Pause/resume a schedule. Paused schedules also skip their queued fires. */
export async function toggleScheduleAction(
  projectId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<void> {
  const denied = await requireOperator(projectId);
  if (denied) return;
  const { projectSchedules } = await import("@/db/schema");
  await db
    .update(projectSchedules)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(projectSchedules.id, scheduleId), eq(projectSchedules.projectId, projectId)));
  revalidatePath(`/admin/${projectId}/settings`);
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
