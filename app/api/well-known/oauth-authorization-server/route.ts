import { NextRequest } from "next/server";
import { originFromHeaders } from "@/lib/origin";
import { ALL_SCOPES } from "@/lib/scopes";

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata. Served at the literal
 * `/.well-known/oauth-authorization-server` via a rewrite (see the sibling
 * route for why).
 *
 * Everything advertised is deliberately narrow: authorization_code only (no
 * implicit — removed in OAuth 2.1; no client_credentials — there is no human to
 * consent, and consent is the point), S256-only PKCE (offering `plain` would
 * let an interceptor replay an authorization request), and `none` for token
 * auth because MCP clients are public clients that cannot keep a secret.
 */
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const origin = originFromHeaders((n) => req.headers.get(n)) ?? new URL(req.url).origin;
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      scopes_supported: ALL_SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      resource_indicators_supported: true,
    },
    { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
  );
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}
