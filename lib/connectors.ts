import { and, eq, sql } from "drizzle-orm";
import { unstable_cache, revalidateTag } from "next/cache";
import { db } from "@/db";
import { projectConnectors, type ProjectConnector } from "@/db/schema";
import { encryptSecret, decryptSecret } from "./crypto";
import { emailProvider } from "./providers/email";
import {
  STRIPE_API_BASE,
  STRIPE_VERSION,
  createWebhookEndpoint,
  getWebhookEndpoint,
  deleteWebhookEndpoint,
} from "./stripe";

/**
 * BYO-infra connectors. Config (non-secret) + optionally one encrypted secret
 * per connector. Agents see status via list_connectors — never config values
 * they don't need, never secrets.
 */

export type ConnectorType = "clerk" | "resend" | "elastic_email" | "stripe" | "neon" | "r2";

/**
 * CONNECTOR CATEGORIES (the provider registry). A category is the CAPABILITY
 * ("send email"); the connector type is the PROVIDER implementing it. Adding a
 * provider = an adapter + a line here; nothing that consumes the category
 * changes. Same rule as plugin capabilities, one layer down: ONE ACTIVE
 * PROVIDER PER CATEGORY, enforced at connect time (never retroactively — a
 * project connected before the rule keeps working exactly as it is).
 *
 * Derived, not stored: no migration, and existing rows are untouched.
 *
 * `database` is deliberately a category of ONE and always will be — the data
 * LIVES there, so "switching" is a migration, not a toggle. It keeps its own
 * tiered model (shared / managed / BYO + the migration gate). `storage` is
 * likewise single today: existing assets don't teleport between buckets.
 */
export type ConnectorCategory = "auth" | "email" | "payments" | "database" | "storage";

export const PROVIDER_CATEGORY: Record<ConnectorType, ConnectorCategory> = {
  clerk: "auth",
  resend: "email",
  elastic_email: "email",
  stripe: "payments",
  neon: "database",
  r2: "storage",
};

/** Provider types serving a category, in registry (tiebreak) order. */
export function providersFor(category: ConnectorCategory): ConnectorType[] {
  return (Object.keys(PROVIDER_CATEGORY) as ConnectorType[]).filter(
    (t) => PROVIDER_CATEGORY[t] === category,
  );
}

/** Categories a tenant may switch providers within (stateless dispatch only). */
export const SWAPPABLE_CATEGORIES: ConnectorCategory[] = ["email"];

/**
 * The connectors the GENERIC settings form may save. `neon` and `r2` are
 * deliberately not in this set: their connect flows validate the target (and
 * install schema / probe public serving) BEFORE anything is stored
 * (lib/neon-connector.ts, lib/r2-connector.ts) — a plain form save would
 * bypass that, so the form action's type simply cannot express them.
 */
export type FormConnectorType = Exclude<ConnectorType, "neon" | "r2">;

export const CONNECTOR_SPECS: Record<
  FormConnectorType,
  {
    label: string;
    configFields: { key: string; label: string; placeholder: string }[];
    secretLabel: string | null;
    /** Named secret slots beyond the primary (stored in secretsEnc[slot]). */
    extraSecrets?: { slot: string; label: string }[];
  }
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
  elastic_email: {
    label: "Elastic Email (email actions)",
    configFields: [
      { key: "fromEmail", label: "From address — must be a verified sender/domain in Elastic Email", placeholder: "notifications@yourdomain.com" },
    ],
    secretLabel: "API key",
  },
  stripe: {
    label: "Stripe (payments)",
    configFields: [
      { key: "publishableKey", label: "Publishable key (pk_…) — public, embeddable in your storefront", placeholder: "pk_test_…" },
    ],
    secretLabel: "Secret key (sk_…)",
    extraSecrets: [
      { slot: "webhookSigning", label: "Webhook signing secret (whsec_…) — from the endpoint you register" },
    ],
  },
};

export const connectorsTag = (projectId: string) => `connectors:${projectId}`;
const tag = connectorsTag;

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

/**
 * A secret-shaped value must NEVER sit in a non-secret config field. `config`
 * is returned verbatim by list_connectors (and readable by the agent), so a
 * secret mis-pasted into e.g. Clerk's publishableKey would leak — a dogfood
 * build hit exactly this. Reject it at save time instead of faithfully storing
 * it. sk_/rk_ (Clerk + Stripe secret/restricted keys) and whsec_ (webhook
 * signing secrets) are never legitimately public config values.
 */
export function secretShapedConfigRefusal(config: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(config)) {
    if (/^(sk|rk)_(test|live)_/.test(value) || /^whsec_/.test(value)) {
      return `That looks like a SECRET key in the "${key}" field — that field is PUBLIC (it's returned by list_connectors, readable by the agent). Put the secret in the secret field; use only the public key (pk_…) here.`;
    }
  }
  return null;
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
    { tags: [tag(projectId)], revalidate: 60 }, // per-instance revalidateTag — TTL converges the fleet
  );
  const row = await cached();
  if (!row) return null;
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

export async function listConnectors(projectId: string): Promise<ProjectConnector[]> {
  return db.select().from(projectConnectors).where(eq(projectConnectors.projectId, projectId));
}

/**
 * Resolve the ACTIVE provider for a category. Deterministic by construction:
 * registry order is the tiebreak, so a project that has only Resend connected
 * resolves to Resend — byte-identical to the hardcoded behavior it replaces.
 * Returns null when the category has no connected provider.
 */
export async function activeProvider(
  projectId: string,
  category: ConnectorCategory,
): Promise<{ type: ConnectorType; connector: ProjectConnector } | null> {
  const types = providersFor(category);
  for (const type of types) {
    const connector = await getConnector(projectId, type);
    if (connector) return { type, connector };
  }
  // Fresh-on-miss — the standing gate rule: a DENY must never rest on a cached
  // read. The cached lookup lags a just-connected provider by up to a TTL (and
  // across instances, revalidateTag only clears the local one), so concluding
  // "no provider in this category" without confirming would refuse email on a
  // project that just connected one. Same fix as getAuthConfig's; paid only on
  // the miss path, which is rare and already an error branch.
  for (const type of types) {
    const fresh = await getConnectorFresh(projectId, type);
    if (fresh) return { type, connector: fresh };
  }
  return null;
}

/** Cheap "is this capability available?" for the define-time gates. */
export async function hasProvider(projectId: string, category: ConnectorCategory): Promise<boolean> {
  return (await activeProvider(projectId, category)) !== null;
}

/**
 * Connect-time guard: refuse a SECOND provider in a swappable category and
 * name the remedy. Deliberately NOT an auto-swap — silently disconnecting a
 * tenant's live email provider on a form save would be rude, and infra
 * credentials deserve an explicit act. Returns a refusal message, or null.
 */
export async function categoryConflict(
  projectId: string,
  type: ConnectorType,
): Promise<{ other: ConnectorType; message: string } | null> {
  const category = PROVIDER_CATEGORY[type];
  if (!SWAPPABLE_CATEGORIES.includes(category)) return null;
  for (const other of providersFor(category)) {
    if (other === type) continue;
    if (await getConnector(projectId, other)) {
      const otherLabel = CONNECTOR_SPECS[other as FormConnectorType]?.label ?? other;
      return {
        other,
        // Names the remedy AND the one-click path. Before EE-1 this said only
        // "disconnect it first", which read as a wall: the operator who hit it
        // had a valid key and no way to tell that a two-step existed.
        message:
          `This project already uses ${otherLabel} for ${category}. ` +
          `One active provider per category — switch to this one, or disconnect ${otherLabel} first. ` +
          `(Content and settings are untouched either way.)`,
      };
    }
  }
  return null;
}

/** Uncached fetch — the fresh-on-miss half of the gate rule (see getAuthConfig). */
async function getConnectorFresh(
  projectId: string,
  type: ConnectorType,
): Promise<ProjectConnector | null> {
  const rows = await db
    .select()
    .from(projectConnectors)
    .where(and(eq(projectConnectors.projectId, projectId), eq(projectConnectors.type, type)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

export async function upsertConnector(
  projectId: string,
  type: ConnectorType,
  config: Record<string, string>,
  secret?: string,
  /** Named slots (e.g. webhookSigning) — merged into secretsEnc, existing slots kept. */
  extraSecrets?: Record<string, string>,
): Promise<void> {
  const extraEnc = extraSecrets
    ? Object.fromEntries(Object.entries(extraSecrets).map(([k, v]) => [k, encryptSecret(v)]))
    : null;
  const values = {
    projectId,
    type,
    config,
    secretEnc: secret ? encryptSecret(secret) : null,
    secretsEnc: extraEnc,
    status: "connected",
    updatedAt: new Date(),
  };
  await db
    .insert(projectConnectors)
    .values(values)
    .onConflictDoUpdate({
      target: [projectConnectors.projectId, projectConnectors.type],
      set: {
        // MERGE, don't replace: the connector form rewrites every field it owns
        // (empty ones become ""), so a merge only preserves NON-form keys — e.g.
        // stripe's webhookEndpointId, set by provisioning. Replacing would drop
        // it on any Save, silently unmonitoring + orphaning the webhook endpoint.
        config: sql`coalesce(${projectConnectors.config}, '{}'::jsonb) || ${JSON.stringify(values.config)}::jsonb`,
        // Keep the existing secret(s) when the form is saved without new ones —
        // slots merge via || so an omitted slot is never dropped.
        ...(secret ? { secretEnc: values.secretEnc } : {}),
        ...(extraEnc
          ? {
              secretsEnc: sql`coalesce(${projectConnectors.secretsEnc}, '{}'::jsonb) || ${JSON.stringify(extraEnc)}::jsonb`,
            }
          : {}),
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
  slot?: string,
): Promise<string | null> {
  const c = await getConnector(projectId, type);
  if (!c) return null;
  if (slot) {
    // Named slots NEVER fall back to the primary secret: a signature check
    // that silently verified against the API key would reject every genuine
    // event — or accept a forged one if that key ever leaked. Absent slot =
    // unconfigured, full stop.
    const enc = c.secretsEnc?.[slot];
    return enc ? decryptSecret(enc) : null;
  }
  if (!c.secretEnc) return null;
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
  let c = await getConnector(projectId, "clerk");
  if (!c?.config.issuer) {
    // Fresh-on-miss (wall report, Fatsoz): the cached connector lags a
    // JUST-connected issuer by up to a TTL, so the delivery gate answered
    // E_CONNECTOR_REQUIRED while list_connectors (fresh) already said
    // connected. A deny-shaped conclusion ("unconfigured") must never come
    // from cache alone — confirm against the DB first. Projects WITH a
    // connector never pay this read; projects without pay it only on
    // requests that present identity (rare, rate-limited).
    c = await getConnectorFresh(projectId, "clerk");
  }
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
  type: FormConnectorType,
  newSecret: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!CONNECTOR_SPECS[type].secretLabel) {
    return { ok: false, detail: "this connector has no secret to rotate" };
  }
  if (!newSecret.trim()) return { ok: false, detail: "enter the new key" };
  const existing = await getConnector(projectId, type);
  if (!existing) return { ok: false, detail: "connector not connected" };

  // Email providers validate through their adapter — one method serving both
  // rotation and the health probe, so a new provider gets both for free.
  const emailAdapter = emailProvider(type);
  if (emailAdapter) {
    const probe = await emailAdapter.verifyKey(newSecret.trim());
    if (!probe.ok) {
      return { ok: false, detail: `${emailAdapter.label} rejected the new key (${probe.detail}) — old key kept` };
    }
  } else if (type === "stripe") {
    try {
      const res = await fetch(`${STRIPE_API_BASE}/v1/account`, {
        headers: { Authorization: `Bearer ${newSecret.trim()}`, "Stripe-Version": STRIPE_VERSION },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return { ok: false, detail: `Stripe rejected the new key (HTTP ${res.status}) — old key kept` };
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
    if (type === "neon") {
      // The tenant DB is healthy iff it connects AND reports the expected
      // schema version (design §8's neon probe). Version 0 = never migrated.
      const conn = await connectorSecret(projectId, "neon");
      if (!conn) return { ok: false, detail: "no connection string stored" };
      const { tenantSchemaVersion, TENANT_SCHEMA_VERSION } = await import("./tenant-migrations");
      const v = await tenantSchemaVersion(conn);
      ok = v === TENANT_SCHEMA_VERSION;
      detail = ok
        ? `database reachable, schema v${v} (current)`
        : v === 0
          ? "database reachable but the data-plane schema is not installed — reconnect to install"
          : `database reachable but schema v${v} ≠ expected v${TENANT_SCHEMA_VERSION} — content ops are quarantined until it migrates`;
    } else if (type === "r2") {
      // The full-loop storage probe: write, read back through the public base,
      // delete — the same check connect/provision ran (A4). MANAGED rows carry
      // no stored secret by design (platform credentials); only BYO decrypts.
      const c = await getConnector(projectId, "r2");
      if (!c?.config.bucket || !c.config.accountId) {
        return { ok: false, detail: "no bucket configured" };
      }
      if (!c.config.publicBaseUrl) {
        return { ok: false, detail: "bucket exists but its public URL isn't live yet — retry provisioning" };
      }
      const managed = c.config.mode === "managed";
      if (!managed && !c.secretEnc) return { ok: false, detail: "no credentials stored" };
      const creds = managed
        ? { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! }
        : (JSON.parse(decryptSecret(c.secretEnc!)) as { accessKeyId: string; secretAccessKey: string });
      const { probeBucket } = await import("./r2-connector");
      const res = await probeBucket({
        accountId: c.config.accountId,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        bucket: c.config.bucket,
        publicBaseUrl: c.config.publicBaseUrl,
      });
      ok = res.ok;
      detail = res.detail;
    } else if (type === "clerk") {
      const auth = await getAuthConfig(projectId);
      if (!auth) return { ok: false, detail: "no issuer configured" };
      const res = await fetch(auth.jwksUrl, { signal: AbortSignal.timeout(8000) });
      ok = res.ok;
      detail = ok ? "JWKS reachable" : `JWKS returned HTTP ${res.status}`;
    } else if (emailProvider(type)) {
      const adapter = emailProvider(type)!;
      const key = await connectorSecret(projectId, type);
      if (!key) return { ok: false, detail: "no API key stored" };
      const probe = await adapter.verifyKey(key);
      ok = probe.ok;
      detail = probe.detail;
    } else {
      // stripe: the secret key is valid iff GET /v1/account succeeds.
      const key = await connectorSecret(projectId, "stripe");
      if (!key) return { ok: false, detail: "no secret key stored" };
      const res = await fetch(`${STRIPE_API_BASE}/v1/account`, {
        headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION },
        signal: AbortSignal.timeout(8000),
      });
      ok = res.ok;
      detail = ok ? "secret key valid" : `Stripe returned HTTP ${res.status}`;
      // K5: if a webhook endpoint was provisioned, report whether it still fires
      // (a disabled/deleted one silently strands paid orders as pending).
      if (ok) {
        const epId = (await getConnector(projectId, "stripe"))?.config.webhookEndpointId;
        if (epId) {
          const ep = await getWebhookEndpoint(key, epId);
          detail = !ep
            ? "secret key valid, but the webhook endpoint is missing — re-provision"
            : ep.status !== "enabled"
              ? `secret key valid, but the webhook endpoint is ${ep.status} — re-provision`
              : "secret key valid, webhook endpoint enabled";
        }
      }
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

/**
 * K5: one-click webhook provisioning. Registers the project's webhook URL with
 * Stripe using the stored sk and persists BOTH the returned endpoint id (config,
 * non-secret) and the returned signing secret (secretsEnc.webhookSigning) —
 * Stripe returns the whsec only at creation, so the operator never copy-pastes
 * it. Re-provisioning deletes the previous endpoint first so it isn't orphaned.
 */
export async function provisionStripeWebhook(
  projectId: string,
  webhookUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  const sk = await connectorSecret(projectId, "stripe");
  if (!sk) return { ok: false, detail: "connect the Stripe secret key first" };
  const existing = await getConnector(projectId, "stripe");
  if (!existing) return { ok: false, detail: "Stripe connector is not connected" };
  // Re-provision: drop the prior endpoint before making a new one (best-effort,
  // so a stale/deleted id can't block re-provisioning).
  const priorId = existing.config.webhookEndpointId;
  if (priorId) {
    try {
      await deleteWebhookEndpoint(sk, priorId);
    } catch {
      /* leftover endpoint is harmless — its deliveries fail signature */
    }
  }
  try {
    const { id, secret } = await createWebhookEndpoint(sk, webhookUrl);
    await upsertConnector(
      projectId,
      "stripe",
      { ...existing.config, webhookEndpointId: id },
      undefined, // keep the existing sk
      { webhookSigning: secret },
    );
    return { ok: true, detail: "webhook provisioned — signing secret stored automatically" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `Stripe rejected the request (${msg})` };
  }
}

/** K5: best-effort delete of the provisioned endpoint (called before disconnect). */
export async function deprovisionStripeWebhook(projectId: string): Promise<void> {
  const existing = await getConnector(projectId, "stripe");
  const id = existing?.config.webhookEndpointId;
  if (!id) return;
  const sk = await connectorSecret(projectId, "stripe");
  if (!sk) return;
  try {
    await deleteWebhookEndpoint(sk, id);
  } catch {
    // Best-effort: a leftover endpoint in Stripe is harmless (it just 401s on
    // delivery once the connector's secret is gone) and the operator can prune it.
  }
}
