import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { revalidateTag, unstable_cache } from "next/cache";
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
  /** This token's row id — TOK-1 stamps it as `mintedByTokenId` on anything it
   * mints, so a leaked token's descendants are identifiable (and cascade-revoked
   * with it). Never leaves the server as part of an auth answer. */
  tokenId: string;
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
          tokenId: projectTokens.id,
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
        tokenId: r.tokenId,
        projectId: r.projectId,
        scope: r.scope as TokenInfo["scope"],
        env: r.env,
        projectStatus: r.projectStatus,
        billing: (paid && !r.billingExempt && r.billingStatus === "canceled" ? "canceled" : "ok") as TokenInfo["billing"],
      };
    },
    // v6: value shape gained `tokenId` (TOK-1) — never serve a cached v5 shape,
    // which would leave mints with no parentage to stamp.
    ["token-v6", hash],
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

/**
 * TOK-1 — the MCP-side token lifecycle (mint / list / revoke), authorized by
 * the CALLING TOKEN itself rather than a Clerk session (`mintToken` in the
 * admin actions stays the human path; MCP has no session to reuse).
 *
 * The security shape, settled with the operator 2026-07-22:
 *  - Scope is HARD-FIXED to 'delivery'. Not a defaulted parameter — no
 *    parameter at all. An mcp token minting mcp tokens would be lateral
 *    privilege and would defeat revocation (revoke one, the holder has three
 *    more). Delivery-only keeps every mint strictly weaker than its minter.
 *  - PARENTAGE: every mint stamps mintedByTokenId = the calling token's row.
 *    The FK is ON DELETE CASCADE, so revoking a compromised token kills its
 *    descendants in the same statement — the persistence risk (a foothold
 *    surviving remediation) is structurally gone, not policy-mitigated.
 *  - CAP: bounded live delivery tokens per project, so a looping agent cannot
 *    mint without limit. The refusal names the remedy (revoke or reuse).
 *  - The lifecycle is mint AND list AND revoke: mint-only would mean a leaked
 *    token could only be buried under new ones, never rotated out.
 */

export const DELIVERY_TOKEN_CAP = 25;

export interface MintDeliveryResult {
  ok: boolean;
  /** Shown ONCE — the platform stores only the hash. */
  token?: string;
  tokenId?: string;
  error?: string;
}

export async function mintDeliveryTokenViaMcp(
  projectId: string,
  mintedByTokenId: string,
  label: string,
): Promise<MintDeliveryResult> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(projectTokens)
    .where(and(eq(projectTokens.projectId, projectId), eq(projectTokens.scope, "delivery")));
  if (Number(n) >= DELIVERY_TOKEN_CAP) {
    return {
      ok: false,
      error:
        `this project already has ${n} live delivery tokens (cap ${DELIVERY_TOKEN_CAP}) — ` +
        `revoke unused ones with revoke_delivery_token (list them via list_delivery_tokens) or reuse an existing token`,
    };
  }
  const raw = generateToken();
  const [row] = await db
    .insert(projectTokens)
    .values({
      projectId,
      tokenHash: hashToken(raw),
      scope: "delivery",
      label: label.trim() || null,
      mintedByTokenId,
    })
    .returning({ id: projectTokens.id });
  return { ok: true, token: raw, tokenId: row.id };
}

export interface DeliveryTokenRow {
  id: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** True when an agent minted it over MCP (vs a human in the console). */
  agentMinted: boolean;
}

export async function listDeliveryTokens(projectId: string): Promise<DeliveryTokenRow[]> {
  const rows = await db
    .select({
      id: projectTokens.id,
      label: projectTokens.label,
      createdAt: projectTokens.createdAt,
      lastUsedAt: projectTokens.lastUsedAt,
      mintedBy: projectTokens.mintedByTokenId,
    })
    .from(projectTokens)
    .where(and(eq(projectTokens.projectId, projectId), eq(projectTokens.scope, "delivery")))
    .orderBy(desc(projectTokens.createdAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: new Date(r.createdAt),
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt) : null,
    agentMinted: r.mintedBy !== null,
  }));
}

export async function revokeDeliveryTokenViaMcp(
  projectId: string,
  tokenId: string,
): Promise<{ ok: boolean; cascaded?: number; error?: string }> {
  // Delivery-scope only, matched within the caller's project: an MCP token can
  // never revoke an mcp-scoped token (its own or a sibling) through this path —
  // credential surgery on the master scope stays a human act in the console.
  const target = await db
    .select({ id: projectTokens.id })
    .from(projectTokens)
    .where(
      and(
        eq(projectTokens.id, tokenId),
        eq(projectTokens.projectId, projectId),
        eq(projectTokens.scope, "delivery"),
      ),
    )
    .limit(1);
  if (!target[0]) {
    return { ok: false, error: `no delivery token ${tokenId} in this project — list_delivery_tokens shows what exists` };
  }
  // Count descendants BEFORE the delete reaps them (delivery tokens cannot
  // mint, so today this is always 0 — counted anyway so the audit note stays
  // honest if scopes ever widen).
  const [{ n }] = await db
    .select({ n: count() })
    .from(projectTokens)
    .where(and(eq(projectTokens.mintedByTokenId, tokenId), isNotNull(projectTokens.mintedByTokenId)));
  await db.delete(projectTokens).where(eq(projectTokens.id, tokenId));
  // Token→project resolution is cached; drop it so the revoked token dies NOW
  // on this instance (the 5-min TTL is the cross-instance backstop).
  revalidateTag("project-tokens");
  return { ok: true, cascaded: Number(n) };
}
