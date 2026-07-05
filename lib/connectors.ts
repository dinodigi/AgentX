import { and, eq } from "drizzle-orm";
import { unstable_cache, revalidateTag } from "next/cache";
import { db } from "@/db";
import { projectConnectors, type ProjectConnector } from "@/db/schema";
import { encryptSecret, decryptSecret } from "./crypto";

/**
 * BYO-infra connectors. Config (non-secret) + optionally one encrypted secret
 * per connector. Agents see status via list_connectors — never config values
 * they don't need, never secrets.
 */

export type ConnectorType = "clerk" | "resend";

export const CONNECTOR_SPECS: Record<
  ConnectorType,
  { label: string; configFields: { key: string; label: string; placeholder: string }[]; secretLabel: string | null }
> = {
  clerk: {
    label: "Clerk (end-user auth)",
    configFields: [
      {
        key: "issuer",
        label: "Issuer URL",
        placeholder: "https://your-app.clerk.accounts.dev",
      },
      {
        key: "publishableKey",
        label: "Publishable key (safe to expose; sites use it for sign-in UI)",
        placeholder: "pk_test_…",
      },
    ],
    secretLabel: null, // JWT verification only needs the public JWKS
  },
  resend: {
    label: "Resend (email actions)",
    configFields: [
      { key: "fromEmail", label: "From address", placeholder: "notifications@yourdomain.com" },
    ],
    secretLabel: "API key",
  },
};

const tag = (projectId: string) => `connectors:${projectId}`;

export async function getConnector(
  projectId: string,
  type: ConnectorType,
): Promise<ProjectConnector | null> {
  const cached = unstable_cache(
    async () => {
      const rows = await db
        .select()
        .from(projectConnectors)
        .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, type)))
        .limit(1);
      return rows[0] ?? null;
    },
    ["connector", projectId, type],
    { tags: [tag(projectId)] },
  );
  const row = await cached();
  if (!row) return null;
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

export async function listConnectors(projectId: string): Promise<ProjectConnector[]> {
  return db.select().from(projectConnectors).where(eq(projectConnectors.projectId, projectId));
}

export async function upsertConnector(
  projectId: string,
  type: ConnectorType,
  config: Record<string, string>,
  secret?: string,
): Promise<void> {
  const values = {
    projectId,
    type,
    config,
    secretEnc: secret ? encryptSecret(secret) : null,
    status: "connected",
    updatedAt: new Date(),
  };
  await db
    .insert(projectConnectors)
    .values(values)
    .onConflictDoUpdate({
      target: [projectConnectors.projectId, projectConnectors.type],
      set: {
        config: values.config,
        // Keep the existing secret when the form is saved without a new one.
        ...(secret ? { secretEnc: values.secretEnc } : {}),
        status: "connected",
        updatedAt: values.updatedAt,
      },
    });
  revalidateTag(tag(projectId));
}

export async function removeConnector(projectId: string, type: ConnectorType): Promise<void> {
  await db
    .delete(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, type)));
  revalidateTag(tag(projectId));
}

/** Decrypted secret for server-side use ONLY. Never returns through a tool. */
export async function connectorSecret(
  projectId: string,
  type: ConnectorType,
): Promise<string | null> {
  const c = await getConnector(projectId, type);
  if (!c?.secretEnc) return null;
  return decryptSecret(c.secretEnc);
}

/** End-user auth config: the Clerk connector is the source of truth. */
export async function getAuthConfig(
  projectId: string,
): Promise<{ issuer: string; jwksUrl: string } | null> {
  const c = await getConnector(projectId, "clerk");
  const issuer = c?.config.issuer?.replace(/\/$/, "");
  if (!issuer) return null;
  return { issuer, jwksUrl: `${issuer}/.well-known/jwks.json` };
}

/** Reachability probe per connector type; updates stored status. */
export async function checkConnectorHealth(
  projectId: string,
  type: ConnectorType,
): Promise<{ ok: boolean; detail: string }> {
  let ok = false;
  let detail = "";
  try {
    if (type === "clerk") {
      const auth = await getAuthConfig(projectId);
      if (!auth) return { ok: false, detail: "no issuer configured" };
      const res = await fetch(auth.jwksUrl, { signal: AbortSignal.timeout(8000) });
      ok = res.ok;
      detail = ok ? "JWKS reachable" : `JWKS returned HTTP ${res.status}`;
    } else {
      const key = await connectorSecret(projectId, "resend");
      if (!key) return { ok: false, detail: "no API key stored" };
      const res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      ok = res.ok;
      detail = ok ? "API key valid" : `Resend returned HTTP ${res.status}`;
    }
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
  }
  await db
    .update(projectConnectors)
    .set({ status: ok ? "connected" : "error", updatedAt: new Date() })
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, type)));
  revalidateTag(tag(projectId));
  return { ok, detail };
}
