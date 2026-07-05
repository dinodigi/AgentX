import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getAuthConfig } from "./connectors";

/**
 * End-user JWT verification for the delivery API (Phase 4). Tokens are issued
 * by the PROJECT'S OWN identity provider (its Clerk instance, connected via
 * the Connectors tab) — never by our platform Clerk. Verification is purely
 * cryptographic: fetch the issuer's public JWKS (cached), check signature,
 * issuer, and expiry. No secrets involved, no per-request calls to Clerk.
 */

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(url: string) {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
    jwksCache.set(url, set);
  }
  return set;
}

export interface EndUser {
  /** Stable user id from the token's sub claim — what ownerField stores. */
  id: string;
  claims: JWTPayload;
}

export type UserAuthResult =
  | { status: "ok"; user: EndUser }
  | { status: "none" } // no token presented
  | { status: "invalid"; reason: string }
  | { status: "unconfigured" }; // collection needs auth but project has no issuer

/** Verify the X-User-Token header value against the project's issuer. */
export async function verifyEndUser(
  projectId: string,
  userToken: string | null,
): Promise<UserAuthResult> {
  if (!userToken) return { status: "none" };
  const auth = await getAuthConfig(projectId);
  if (!auth) return { status: "unconfigured" };
  try {
    const { payload } = await jwtVerify(userToken, jwksFor(auth.jwksUrl), {
      issuer: auth.issuer,
    });
    if (!payload.sub) return { status: "invalid", reason: "token has no sub claim" };
    return { status: "ok", user: { id: payload.sub, claims: payload } };
  } catch (e) {
    return { status: "invalid", reason: e instanceof Error ? e.message : String(e) };
  }
}
