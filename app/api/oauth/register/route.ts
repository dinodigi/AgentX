import { NextRequest } from "next/server";
import { registerClient, isValidRedirectUri } from "@/lib/oauth";
import { readBounded } from "@/lib/http";

/**
 * RFC 7591 — Dynamic Client Registration.
 *
 * Registration is intentionally OPEN (no auth). That looks alarming and is not:
 * a client_id grants nothing by itself. Every access token still requires a
 * human to sign in with Clerk, choose a project, and approve scopes on the
 * consent screen. What an attacker gets by registering is the ability to *ask*
 * — which anyone can already do.
 *
 * The real defense lives in the redirect allowlist: codes are only ever sent to
 * a URI registered here and matched EXACTLY at authorize time.
 *
 * Public clients only — no client_secret is issued. MCP clients are CLIs and
 * desktop apps that cannot keep one; PKCE is the protection instead.
 */
export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024;
const MAX_URIS = 10;

function bad(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
  );
}

export async function POST(req: NextRequest) {
  const text = await readBounded(req, MAX_BODY);
  if (text === null) return bad("invalid_client_metadata", "body exceeds 8KB");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad("invalid_client_metadata", "body must be JSON");
  }

  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_URIS) {
    return bad("invalid_redirect_uri", `redirect_uris must be an array of 1..${MAX_URIS} URIs`);
  }
  const redirectUris = uris.map(String);
  const rejected = redirectUris.filter((u) => !isValidRedirectUri(u));
  if (rejected.length) {
    return bad(
      "invalid_redirect_uri",
      `must be https, or http on localhost/127.0.0.1, and carry no fragment — rejected: ${rejected.join(", ")}`,
    );
  }

  // We only support what the metadata advertises. Saying so explicitly beats
  // silently ignoring a client that asked for something it will not get.
  if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== "none") {
    return bad("invalid_client_metadata", "only public clients are supported (token_endpoint_auth_method: none)");
  }
  const grantTypes = Array.isArray(b.grant_types) ? b.grant_types.map(String) : ["authorization_code"];
  if (grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return bad("invalid_client_metadata", "only the authorization_code grant is supported");
  }

  const name = typeof b.client_name === "string" ? b.client_name.slice(0, 120) : undefined;
  const uri = typeof b.client_uri === "string" ? b.client_uri.slice(0, 300) : undefined;

  const { id } = await registerClient({ redirectUris, clientName: name, clientUri: uri });

  return Response.json(
    {
      client_id: id,
      // No client_secret: public client. Its absence is the signal.
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      ...(name ? { client_name: name } : {}),
      ...(uri ? { client_uri: uri } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    { status: 201, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
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
