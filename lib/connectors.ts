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
        key: "publishableKey",
        label: "Publishable key — paste this and Connect; the issuer is derived automatically",
        placeholder: "pk_test_…",
      },
      {
        key: "issuer",
        label: "Issuer URL (optional — derived from the publishable key; set to override)",
        placeholder: "https://your-app.clerk.accounts.dev",
      },
      {
        key: "additionalIssuers",
        label: "Additional accepted issuers (optional, comma-separated — e.g. staging + prod)",
        placeholder: "https://staging-app.clerk.accounts.dev",
      },
      {
        key: "audience",
        label: "Required audience claim (optional; rejects tokens minted for other apps)",
        placeholder: "my-app",
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

/**
 * A Clerk publishable key encodes the instance's frontend API domain:
 * pk_test_<base64("foo-bar-1.clerk.accounts.dev$")>. Deriving the issuer from
 * the key makes connecting one paste — no URL hunting in the Clerk dashboard.
 */
export function deriveClerkIssuer(publishableKey: string): string | null {
  const m = /^pk_(?:test|live)_(.+)$/.exec(publishableKey.trim());
  if (!m) return null;
  try {
    const domain = Buffer.from(m[1], "base64").toString("utf8").replace(/\$$/, "");
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) return null;
    return `https://${domain}`;
  } catch {
    return null;
  }
}

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

export interface AuthConfig {
  issuer: string;
  jwksUrl: string;
  /** All accepted issuers (primary + additional, e.g. staging + prod Clerk). */
  issuers: { issuer: string; jwksUrl: string }[];
  /** When set, tokens must carry this aud claim. */
  audience?: string;
}

/** End-user auth config: the Clerk connector is the source of truth. */
export async function getAuthConfig(projectId: string): Promise<AuthConfig | null> {
  const c = await getConnector(projectId, "clerk");
  const primary = c?.config.issuer?.replace(/\/$/, "");
  if (!primary) return null;
  const additional = (c?.config.additionalIssuers ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const issuers = [primary, ...additional].map((issuer) => ({
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
  }));
  return {
    issuer: primary,
    jwksUrl: issuers[0].jwksUrl,
    issuers,
    audience: c?.config.audience?.trim() || undefined,
  };
}

/**
 * Rotate a connector secret with validation-before-save: the candidate key is
 * probed against the live provider FIRST, and the old key stays in place
 * unless the new one passes — rotation stops being "retype and hope".
 */
export async function rotateConnectorSecret(
  projectId: string,
  type: ConnectorType,
  newSecret: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!CONNECTOR_SPECS[type].secretLabel) {
    return { ok: false, detail: "this connector has no secret to rotate" };
  }
  if (!newSecret.trim()) return { ok: false, detail: "enter the new key" };
  const existing = await getConnector(projectId, type);
  if (!existing) return { ok: false, detail: "connector not connected" };

  if (type === "resend") {
    try {
      const res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${newSecret.trim()}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return { ok: false, detail: `Resend rejected the new key (HTTP ${res.status}) — old key kept` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, detail: `could not validate the new key (${msg}) — old key kept` };
    }
  }

  await db
    .update(projectConnectors)
    .set({ secretEnc: encryptSecret(newSecret.trim()), status: "connected", updatedAt: new Date() })
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, type)));
  revalidateTag(tag(projectId));
  return { ok: true, detail: "new key validated and swapped in" };
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
