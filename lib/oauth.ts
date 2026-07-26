import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { oauthClients, oauthCodes } from "@/db/schema";

/**
 * DX-6 / D3 — the OAuth 2.1 authorization-server half of MCP auth.
 *
 * Pluggie is BOTH the resource server (the MCP endpoint) and the authorization
 * server, which removes the hardest part of the spec: audience binding. Access
 * tokens are opaque rows in `project_tokens`, so a token issued here is only
 * resolvable here — there is no cross-service token to confuse a deputy with.
 * We still record and validate the RFC 8707 `resource` parameter, because a
 * client MUST send it and silently ignoring it would hide client bugs.
 *
 * What this file deliberately does NOT do: issue refresh tokens. v1 issues a
 * long-ish access token and lets the client re-run the flow. Refresh rotation
 * (mandatory for public clients under OAuth 2.1) is real work and belongs in
 * its own pass rather than half-built here.
 */

const CODE_TTL_MS = 10 * 60_000; // OAuth 2.1: authorization codes SHOULD be short-lived
export const ACCESS_TOKEN_TTL_DAYS = 90;

export function generateOpaque(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time compare for anything derived from attacker-supplied input. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * PKCE S256 verification. `plain` is NOT accepted — OAuth 2.1 requires S256 for
 * public clients, and accepting `plain` would let an attacker who intercepted
 * the authorization request replay it.
 */
export function verifyPkce(codeVerifier: string, storedChallenge: string): boolean {
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return safeEqual(computed, storedChallenge);
}

/**
 * Redirect URIs are matched EXACTLY against the registered allowlist — never by
 * prefix or pattern. Prefix matching is the classic open-redirect hole
 * (`https://good.app.evil.com` prefixed by `https://good.app`).
 */
export function redirectUriAllowed(registered: string[], candidate: string): boolean {
  return registered.some((u) => safeEqual(u, candidate));
}

/**
 * Registration-time redirect validation. The spec requires https or localhost —
 * anything else (custom schemes aside) can exfiltrate a code over plaintext.
 * Native MCP clients legitimately use loopback, so those are allowed on http.
 */
export function isValidRedirectUri(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false; // fragments cannot be in a redirect target
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return false;
}

export async function registerClient(input: {
  redirectUris: string[];
  clientName?: string;
  clientUri?: string;
}): Promise<{ id: string }> {
  const id = "pc_" + generateOpaque(18);
  await db.insert(oauthClients).values({
    id,
    redirectUris: input.redirectUris,
    clientName: input.clientName ?? null,
    clientUri: input.clientUri ?? null,
  });
  return { id };
}

export async function getClient(id: string) {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1);
  return row ?? null;
}

/** Issue a single-use authorization code for an approved consent. */
export async function issueCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  projectId: string;
  scopes: string[];
  approvedBy: string;
}): Promise<string> {
  const raw = generateOpaque(32);
  await db.insert(oauthCodes).values({
    codeHash: sha256(raw),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    resource: input.resource,
    projectId: input.projectId,
    scopes: input.scopes,
    approvedBy: input.approvedBy,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  // Opportunistic sweep — expired codes are worthless, and an unbounded table
  // of them is just a slow leak. Same self-healing pattern as the trash sweep.
  void db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, new Date(Date.now() - CODE_TTL_MS))).catch(() => {});
  return raw;
}

export type CodeRedemption =
  | { ok: true; projectId: string; scopes: string[]; approvedBy: string }
  | { ok: false; error: string; description: string };

/**
 * Redeem an authorization code. Single-use is enforced by an atomic
 * compare-and-set on `usedAt` — two concurrent redemptions cannot both win,
 * which is the difference between "unlikely" and "impossible".
 */
export async function redeemCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<CodeRedemption> {
  const hash = sha256(input.code);
  const [row] = await db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, hash)).limit(1);

  const invalid = {
    ok: false as const,
    error: "invalid_grant",
    description: "authorization code is invalid, expired, or already used",
  };
  if (!row) return invalid;
  if (row.usedAt) return invalid;
  if (new Date(row.expiresAt).getTime() <= Date.now()) return invalid;
  // The code was issued TO a specific client FOR a specific redirect. Both must
  // match or a stolen code could be redeemed by a different client.
  if (!safeEqual(row.clientId, input.clientId)) return invalid;
  if (!safeEqual(row.redirectUri, input.redirectUri)) return invalid;
  if (!verifyPkce(input.codeVerifier, row.codeChallenge)) {
    return { ok: false, error: "invalid_grant", description: "PKCE verification failed" };
  }

  // Atomic single-use claim: only the first redemption sees a row updated.
  const claimed = await db
    .update(oauthCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthCodes.codeHash, hash), isNull(oauthCodes.usedAt)))
    .returning({ h: oauthCodes.codeHash });
  if (claimed.length === 0) return invalid; // lost the race — treat as replay

  return { ok: true, projectId: row.projectId, scopes: row.scopes, approvedBy: row.approvedBy };
}

/**
 * The canonical resource identifier for this deployment's MCP server, per
 * RFC 8707 §2 / RFC 9728. No trailing slash, no fragment.
 */
export function canonicalMcpResource(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/mcp`;
}

/**
 * A client MUST send `resource`. We accept a missing one (many clients are
 * still catching up) but reject a MISMATCHED one — silently ignoring a wrong
 * audience is how token-passthrough bugs get built on top of you.
 */
export function resourceAcceptable(resource: string | null, origin: string): boolean {
  if (!resource) return true;
  const want = canonicalMcpResource(origin).toLowerCase();
  const got = resource.replace(/\/+$/, "").toLowerCase();
  return got === want || got === origin.replace(/\/+$/, "").toLowerCase();
}

export async function expireStaleCodes(): Promise<number> {
  const r = await db.execute(sql`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 hour'`);
  return (r as unknown as { rowCount?: number }).rowCount ?? 0;
}
