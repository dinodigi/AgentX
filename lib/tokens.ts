import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/db";
import { projects, projectTokens } from "@/db/schema";

/**
 * Project tokens scope the single MCP server to one project. We store only a
 * hash; the raw token is shown once at creation time.
 */

const PREFIX = "agx_";

export function generateToken(): string {
  return PREFIX + randomBytes(24).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface TokenInfo {
  projectId: string;
  /** 'mcp' = full agent access; 'delivery' = public read/write only (what sites hold). */
  scope: "mcp" | "delivery";
  /** Which data-plane environment the token addresses (A1.3). Always 'prod'
   * until A5 mints dev tokens; carried here so the boundary already knows. */
  env: "prod" | "dev";
  /** B2 lifecycle: the agent + delivery surfaces only serve 'active' projects.
   * Activation must revalidateTag("project-tokens") so it takes effect fast.
   * 'suspended' (B4) = operator abuse lever — same darkness, its own message. */
  projectStatus: "setup" | "active" | "suspended";
  /** B3: 'canceled' = a paid, non-exempt project whose subscription ended —
   * surfaces go dark with a resubscribe message. past_due keeps serving
   * (Stripe dunning is the grace window). */
  billing: "ok" | "canceled";
}

/**
 * Resolve a raw bearer token to its project + scope + env + project status,
 * or null if unknown. Cached cross-request (this runs on EVERY MCP and
 * delivery call); revoking a token OR activating a project must call
 * revalidateTag("project-tokens").
 */
export async function resolveToken(rawToken: string): Promise<TokenInfo | null> {
  if (!rawToken.startsWith(PREFIX)) return null;
  const hash = hashToken(rawToken);
  const cached = unstable_cache(
    async () => {
      const rows = await db
        .select({
          projectId: projectTokens.projectId,
          scope: projectTokens.scope,
          env: projectTokens.env,
          projectStatus: projects.status,
          plan: projects.plan,
          billingStatus: projects.billingStatus,
          billingExempt: projects.billingExempt,
        })
        .from(projectTokens)
        .innerJoin(projects, eq(projects.id, projectTokens.projectId))
        .where(eq(projectTokens.tokenHash, hash))
        .limit(1);
      if (!rows[0]) return null;
      // Cache-miss path = first sighting in ≥TTL — cheap last-used heartbeat.
      void db
        .update(projectTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(projectTokens.tokenHash, hash))
        .catch(() => {});
      const r = rows[0];
      const paid = r.plan === "byo" || r.plan === "managed";
      return {
        projectId: r.projectId,
        scope: r.scope as TokenInfo["scope"],
        env: r.env,
        projectStatus: r.projectStatus,
        billing: (paid && !r.billingExempt && r.billingStatus === "canceled" ? "canceled" : "ok") as TokenInfo["billing"],
      };
    },
    // v5: value shape gained `billing` — never serve a cached v4 shape.
    ["token-v5", hash],
    // TTL as defense-in-depth: a token revoked outside the app (script, other
    // instance) dies within 5 minutes even if no revalidateTag fires.
    { tags: ["project-tokens"], revalidate: 300 },
  );
  return cached();
}

/**
 * Any-scope resolution — the delivery API accepts both scopes. ACTIVE projects
 * only (B2): a setup-state project has no public surface yet, so its tokens
 * read as unknown here (the MCP route gives agents the precise message).
 */
export type DeliveryTokenResult =
  | { ok: true; projectId: string }
  | { ok: false; code: "E_AUTH" | "E_SCOPE"; error: string };

/**
 * Delivery-surface token resolution with a DISTINGUISHABLE wrong-scope answer.
 * Stallion field report: when scope enforcement landed, an MCP token on
 * /api/v1/* read as "invalid or missing project token" — indistinguishable from
 * a typo'd credential, so a live site's operator had no path to the fix. A
 * valid-but-mcp-scoped token now names the problem and the remedy (E_SCOPE),
 * exactly like the MCP endpoint does for the mirror case. Unknown/inactive
 * tokens still answer a generic E_AUTH (no token-probing oracle).
 */
export async function resolveDeliveryToken(rawToken: string | null): Promise<DeliveryTokenResult> {
  const invalid = { ok: false as const, code: "E_AUTH" as const, error: "invalid or missing project token" };
  if (!rawToken) return invalid;
  const info = await resolveToken(rawToken);
  if (!info) return invalid;
  // SCOPE ENFORCEMENT (security — reported via the feedback wall): the delivery
  // surface accepts ONLY delivery-scoped tokens. Previously any active token
  // passed, so the MCP master credential worked on /v1/* — meaning an MCP token
  // leaked into a client context granted public writes PLUS full authoring.
  if (info.scope !== "delivery") {
    return {
      ok: false,
      code: "E_SCOPE",
      error:
        "this token is mcp-scoped (authoring) — the delivery API needs a delivery-scoped token; " +
        "mint one in project Settings → Tokens (or ask the agent to use its own delivery token) and " +
        "never embed the MCP token in a site or client",
    };
  }
  if (info.projectStatus !== "active" || info.billing !== "ok") return invalid;
  return { ok: true, projectId: info.projectId };
}

export async function resolveProjectId(rawToken: string): Promise<string | null> {
  const r = await resolveDeliveryToken(rawToken);
  return r.ok ? r.projectId : null;
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
