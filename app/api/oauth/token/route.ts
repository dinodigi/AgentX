import { NextRequest } from "next/server";
import { redeemCode, resourceAcceptable, ACCESS_TOKEN_TTL_DAYS } from "@/lib/oauth";
import { issueOauthAccessToken } from "@/lib/tokens";
import { originFromHeaders } from "@/lib/origin";
import { readBounded } from "@/lib/http";

/**
 * OAuth 2.1 token endpoint — authorization_code + PKCE.
 *
 * The access token issued here is an ordinary `project_tokens` row: hashed at
 * rest, scoped (D2), expiring (D1), and parented for cascade revoke (TOK-1).
 * That is the payoff of building those first — OAuth issues INTO an existing,
 * already-hardened credential system rather than inventing a parallel one.
 *
 * Audience binding is structural: tokens are opaque and only resolvable against
 * our own table, so a token minted here cannot be replayed at another service.
 * We still validate `resource` when sent, because ignoring a mismatched
 * audience is how token-passthrough bugs get built on top of you.
 *
 * No refresh tokens in v1 — see lib/oauth.ts. Rotation for public clients is
 * mandatory under OAuth 2.1 and deserves its own pass, not a half-built one.
 */
export const dynamic = "force-dynamic";

const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store" };

function oauthError(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, { status, headers: CORS });
}

export async function POST(req: NextRequest) {
  const raw = await readBounded(req, 8 * 1024);
  if (raw === null) return oauthError("invalid_request", "body exceeds 8KB");
  let params: URLSearchParams;
  try {
    const ct = req.headers.get("content-type") ?? "";
    // OAuth mandates form encoding; accept JSON too since some clients send it.
    params = ct.includes("application/json")
      ? new URLSearchParams(Object.entries(JSON.parse(raw)).map(([k, v]) => [k, String(v)]))
      : new URLSearchParams(raw);
  } catch {
    return oauthError("invalid_request", "body must be form-encoded or JSON");
  }

  if (params.get("grant_type") !== "authorization_code") {
    return oauthError("unsupported_grant_type", "only authorization_code is supported");
  }

  const code = params.get("code");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");
  const resource = params.get("resource");

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return oauthError(
      "invalid_request",
      "code, client_id, redirect_uri and code_verifier are all required (PKCE is mandatory)",
    );
  }

  const origin = originFromHeaders((n) => req.headers.get(n)) ?? new URL(req.url).origin;
  if (!resourceAcceptable(resource, origin)) {
    return oauthError(
      "invalid_target",
      `resource must identify this MCP server (${origin}/api/mcp)`,
    );
  }

  // Single-use + PKCE + client/redirect binding are all enforced in redeemCode.
  const redeemed = await redeemCode({ code, clientId, redirectUri, codeVerifier });
  if (!redeemed.ok) return oauthError(redeemed.error, redeemed.description);

  const minted = await issueOauthAccessToken({
    projectId: redeemed.projectId,
    scopes: redeemed.scopes,
    ttlDays: ACCESS_TOKEN_TTL_DAYS,
    label: `oauth · ${clientId.slice(0, 12)}`,
  });

  return Response.json(
    {
      access_token: minted.token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_DAYS * 24 * 60 * 60,
      scope: redeemed.scopes.join(" "),
    },
    { headers: CORS },
  );
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}
