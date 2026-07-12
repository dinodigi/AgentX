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
   * Activation must revalidateTag("project-tokens") so it takes effect fast. */
  projectStatus: "setup" | "active";
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
export async function resolveProjectId(rawToken: string): Promise<string | null> {
  const info = await resolveToken(rawToken);
  return info && info.projectStatus === "active" && info.billing === "ok" ? info.projectId : null;
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
