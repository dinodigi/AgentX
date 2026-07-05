/**
 * CORS for the delivery API. Permissive origin is safe here: authentication
 * is bearer headers (never cookies), so there is no CSRF surface, and a
 * delivery token exposes only public fields by construction.
 */

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-user-token",
  "access-control-max-age": "86400",
};

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
