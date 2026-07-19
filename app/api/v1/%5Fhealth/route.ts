/**
 * Delivery-plane liveness probe (public, unauthenticated BY DESIGN — it
 * exposes nothing and touches no tenant data). Proves the /api/v1 routing
 * surface is up for uptime monitors; deep process+DB health lives at
 * /api/health. The path is `_health`: collection names must match
 * /^[a-z][a-z0-9_]*$/ (no leading underscore), so this static segment can
 * never shadow a real collection's delivery endpoint. The folder is named
 * `%5Fhealth` because a literal `_health` directory would be a Next.js
 * private folder (excluded from routing); %5F is the documented escape.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", surface: "delivery" },
    { headers: { "cache-control": "no-store" } },
  );
}
