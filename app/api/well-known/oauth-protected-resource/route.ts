import { NextRequest } from "next/server";
import { originFromHeaders } from "@/lib/origin";
import { canonicalMcpResource } from "@/lib/oauth";
import { ALL_SCOPES } from "@/lib/scopes";

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata. **MUST** exist for MCP
 * authorization: this is what a client fetches after a 401 to discover which
 * authorization server issues tokens for us.
 *
 * Served at the literal `/.well-known/oauth-protected-resource` via a rewrite
 * in next.config.ts. It lives under /api because the App Router will not route
 * a dot-prefixed directory (the `%2E` escape that works for `_health`'s `%5F`
 * does not apply), and a rewrite is more legible than fighting the router.
 */
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const origin = originFromHeaders((n) => req.headers.get(n)) ?? new URL(req.url).origin;
  return Response.json(
    {
      resource: canonicalMcpResource(origin),
      authorization_servers: [origin],
      scopes_supported: ALL_SCOPES,
      bearer_methods_supported: ["header"],
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
