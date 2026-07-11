"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { clerkClient } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  entriesTrash,
  entryVersions,
  projectConnectors,
  projects,
  projectTokens,
  projectMembers,
  transactReceipts,
} from "@/db/schema";
import { generateToken, hashToken } from "@/lib/tokens";
import { getProjectRole, getViewer } from "@/lib/access";
import { canDeleteProject } from "@/lib/workspaces";
import { deleteProjectObjects } from "@/lib/r2";
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
  const theme = formData.get("theme") === "light" ? "light" : "dark";
  if (!displayName) return { error: "Enter a display name" };
  if (!/^#[0-9a-fA-F]{6}$/.test(primaryColor)) return { error: "Pick a valid color" };

  await db
    .update(projects)
    .set({ branding: { displayName, primaryColor, logoUrl: logoUrl || undefined, theme } })
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
  type: "clerk" | "resend" | "stripe" | "neon" | "r2",
): Promise<{ error?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  if (type === "neon") {
    // Dedicated flow: evicts cached tenant clients; never touches their DB.
    const { disconnectNeonDatabase } = await import("@/lib/neon-connector");
    const res = await disconnectNeonDatabase(projectId);
    revalidatePath(`/admin/${projectId}/connectors`);
    return res.ok ? {} : { error: res.detail };
  }
  if (type === "r2") {
    // Dedicated flow: evicts cached storage clients; never touches their bucket.
    const { disconnectR2Bucket } = await import("@/lib/r2-connector");
    const res = await disconnectR2Bucket(projectId);
    revalidatePath(`/admin/${projectId}/connectors`);
    return res.ok ? {} : { error: res.detail };
  }
  const { removeConnector, deprovisionStripeWebhook } = await import("@/lib/connectors");
  // Best-effort: delete the Stripe webhook endpoint we provisioned before we
  // drop the secret that would let us delete it.
  if (type === "stripe") await deprovisionStripeWebhook(projectId);
  await removeConnector(projectId, type);
  revalidatePath(`/admin/${projectId}/connectors`);
  return {};
}

/**
 * A2: attach a BYO Postgres as this project's data plane. Validate →
 * install (migration runner) → store encrypted → route → replay collection
 * indexes. The generic saveConnector cannot express type "neon" — this is
 * the only path, so a stored neon connector always passed validation.
 */
export async function connectNeonAction(
  projectId: string,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean; detail?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  const connString = String(formData.get("connectionString") ?? "").trim();
  if (!connString) return { error: "Paste the database's connection string" };
  const { connectNeonDatabase } = await import("@/lib/neon-connector");
  const result = await connectNeonDatabase(projectId, connString);
  revalidatePath(`/admin/${projectId}/connectors`);
  return result.ok ? { ok: true, detail: result.detail } : { error: result.detail };
}

/**
 * A4: attach a BYO R2 bucket as this project's storage plane. The probe
 * writes with their keys and reads back through their public base URL before
 * anything is stored — the generic saveConnector cannot express type r2.
 */
export async function connectR2Action(
  projectId: string,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean; detail?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  const field = (k: string) => String(formData.get(k) ?? "").trim();
  const { connectR2Bucket } = await import("@/lib/r2-connector");
  const result = await connectR2Bucket(projectId, {
    accountId: field("accountId"),
    accessKeyId: field("accessKeyId"),
    secretAccessKey: field("secretAccessKey"),
    bucket: field("bucket"),
    publicBaseUrl: field("publicBaseUrl"),
  });
  revalidatePath(`/admin/${projectId}/connectors`);
  return result.ok ? { ok: true, detail: result.detail } : { error: result.detail };
}

/** A3: one-click managed database — a Neon project of the tenant's own,
 * provisioned from OUR org (handle-first, resumable). */
export async function provisionManagedAction(
  projectId: string,
): Promise<{ error?: string; ok?: boolean; detail?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  const { provisionManagedDatabase } = await import("@/lib/neon-connector");
  const result = await provisionManagedDatabase(projectId);
  revalidatePath(`/admin/${projectId}/connectors`);
  return result.ok ? { ok: true, detail: result.detail } : { error: result.detail };
}

/** A3: tear down the managed database (deletes it; Neon keeps it recoverable
 * for 7 days). The card gates this behind an explicit confirm. */
export async function deprovisionManagedAction(
  projectId: string,
): Promise<{ error?: string; ok?: boolean; detail?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  const { deprovisionManagedDatabase } = await import("@/lib/neon-connector");
  const result = await deprovisionManagedDatabase(projectId);
  revalidatePath(`/admin/${projectId}/connectors`);
  return result.ok ? { ok: true, detail: result.detail } : { error: result.detail };
}

/**
 * K5: register the project's Stripe webhook endpoint in one click. The webhook
 * URL is built from the app's PUBLIC origin (proxy-aware, APP_URL override),
 * NOT the request bind — the URL is handed to Stripe, which must reach it.
 */
export async function provisionStripeWebhook(
  projectId: string,
): Promise<{ error?: string; ok?: boolean; detail?: string }> {
  const denied = await requireOperator(projectId);
  if (denied) return { error: denied };
  const { headers } = await import("next/headers");
  const { originFromHeaders } = await import("@/lib/origin");
  const h = await headers();
  const origin = originFromHeaders((n) => h.get(n));
  if (!origin) return { error: "could not determine the app URL — set APP_URL in the environment" };
  const { provisionStripeWebhook: provision } = await import("@/lib/connectors");
  const result = await provision(projectId, `${origin}/api/stripe/webhook/${projectId}`);
  revalidatePath(`/admin/${projectId}/connectors`);
  return result;
}

export async function testConnector(
  projectId: string,
  type: "clerk" | "resend" | "stripe" | "neon" | "r2",
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

/**
 * Permanently delete a project (B2). Destructive = type-the-name confirm.
 * Gated stricter than operator: only the owning workspace's owner/admin (or a
 * platform operator). Deletes the project's R2 objects best-effort, then the
 * `projects` row — FK cascade wipes collections/entries/trash/versions/changes/
 * tokens/members/connectors/jobs/schedules in the control plane. (When a project
 * has a managed data-plane connector, A3/A4 add deprovisioning its Neon DB + R2
 * bucket before this; none exist yet, so the cascade is complete today.)
 */
export async function deleteProjectAction(
  projectId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const viewer = await getViewer();
  if (!viewer) return { error: "not signed in" };
  if (!(await canDeleteProject(projectId, viewer))) {
    return { error: "Only the workspace owner or an admin can delete a project" };
  }

  const [project] = await db
    .select({ name: projects.name, branding: projects.branding })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return { error: "Project not found" };

  const label = project.branding?.displayName ?? project.name;
  const typed = String(formData.get("confirm") ?? "").trim();
  if (typed !== label) {
    return { error: `Type the project name exactly to confirm: ${label}` };
  }

  // Data-plane connector at delete time (B2 decisions): BYO → allowed; we drop
  // OUR control-plane records and routing but NEVER touch the tenant's own
  // database (it's theirs). MANAGED → tear the Neon project down FIRST (A3);
  // a teardown failure blocks the delete so a paid DB is never orphaned
  // silently (Neon keeps deleted projects recoverable for 7 days).
  const [dataPlane] = await db
    .select({ id: projectConnectors.id, config: projectConnectors.config })
    .from(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, "neon")))
    .limit(1);
  if (dataPlane && dataPlane.config?.mode === "managed") {
    const { deprovisionManagedDatabase } = await import("@/lib/neon-connector");
    const teardown = await deprovisionManagedDatabase(projectId);
    if (!teardown.ok) {
      return { error: `Managed database teardown failed — project not deleted. ${teardown.detail}` };
    }
  }

  try {
    await deleteProjectObjects(projectId);
  } catch (e) {
    // Orphaned bytes are recoverable later; never block the delete on R2.
    console.error("R2 cleanup failed during project delete", projectId, e);
  }

  // These four tables are MISSING their project_id FK cascade in the live DB
  // (db:push-vs-PG18 drift, verified by FK audit) — deleting the project would
  // orphan them. Delete explicitly so teardown is complete regardless of the
  // DB's FK state. The other ten tables cascade from `projects` correctly.
  await Promise.all([
    db.delete(projectMembers).where(eq(projectMembers.projectId, projectId)),
    db.delete(entriesTrash).where(eq(entriesTrash.projectId, projectId)),
    db.delete(entryVersions).where(eq(entryVersions.projectId, projectId)),
    db.delete(transactReceipts).where(eq(transactReceipts.projectId, projectId)),
  ]);
  await db.delete(projects).where(eq(projects.id, projectId));
  redirect("/admin");
}
