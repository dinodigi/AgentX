import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { CORS_HEADERS } from "./cors";
import type { ErrorCode } from "./error-codes";
import type { ConstraintIssue } from "./validation";

/**
 * Shared HTTP plumbing for the delivery API: every response carries CORS
 * headers, and every error carries the same {error, code} envelope with a
 * stable code from the registry — sites branch on code, humans read error.
 */

export function corsJson(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: { ...CORS_HEADERS, ...(init?.headers ?? {}) },
  });
}

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: "E_VALIDATION",
  401: "E_AUTH",
  403: "E_SCOPE",
  404: "E_NOT_FOUND",
  409: "E_CONFLICT",
  422: "E_VALIDATION",
  429: "E_RATE_LIMITED",
  500: "E_INTERNAL",
  502: "E_UPSTREAM",
  // Both delivery 503s are "a required connector is not connected" (Stripe at
  // checkout, Clerk issuer at the auth gate) — operator-fixed, not retryable.
  503: "E_CONNECTOR_REQUIRED",
};

export function deliveryError(
  status: number,
  message: string,
  init?: ResponseInit,
  issues?: ConstraintIssue[],
  /** Override the status→code default — e.g. a hook rejection is 422 but must
   *  read E_HOOK_REJECTED, not the generic E_VALIDATION, so clients branch. */
  codeOverride?: ErrorCode,
): Response {
  const code = codeOverride ?? CODE_BY_STATUS[status] ?? "E_INTERNAL";
  return corsJson(
    { error: message, code, ...(issues && issues.length > 0 ? { issues: issues.slice(0, 20) } : {}) },
    { ...init, status },
  );
}

/**
 * Edge-cache TTL (s-maxage) for SHAREABLE delivery responses. A response is
 * shareable only when it is a pure function of (delivery token → project, URL):
 * no x-user-token influence, no owner row-clauses. 0 disables the header (env
 * kill switch — everything falls back to no-cache/revalidate).
 *
 * IMPORTANT: the same URL serves DIFFERENT projects depending on the bearer
 * token, so a shared cache must key per-tenant. `vary: authorization` declares
 * that for spec-respecting caches; Cloudflare needs the worker in
 * infra/cloudflare/delivery-cache-worker.js (hashes the token into the key).
 */
const EDGE_TTL = (() => {
  const n = Number(process.env.DELIVERY_EDGE_TTL_SECONDS ?? 60);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60;
})();

/**
 * 200 with a strong ETag, or 304 when If-None-Match matches. cache-control
 * no-cache = "revalidate every time": clients and CDNs skip the body transfer
 * on a hit but never serve stale content (entries change without URL busts).
 *
 * `share: true` (public reads only) adds s-maxage so a per-tenant-keyed shared
 * cache may serve for the TTL without touching origin; max-age=0 keeps direct
 * clients revalidating exactly as before.
 */
export function cachedJson(req: NextRequest, body: unknown, opts?: { share?: boolean }): Response {
  const json = JSON.stringify(body);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 32);
  const etag = `"${hash}"`;
  const cacheHeaders: Record<string, string> =
    opts?.share && EDGE_TTL > 0
      ? {
          etag,
          "cache-control": `max-age=0, s-maxage=${EDGE_TTL}, stale-while-revalidate=${EDGE_TTL * 5}`,
          vary: "authorization, x-user-token",
        }
      : { etag, "cache-control": "no-cache" };
  // Match by hash inclusion, not equality: CDNs mutate ETags in flight
  // (Netlify appends -df for compressed responses; proxies add W/ markers).
  if (req.headers.get("if-none-match")?.includes(hash)) {
    return new Response(null, { status: 304, headers: { ...CORS_HEADERS, ...cacheHeaders } });
  }
  return new Response(json, {
    status: 200,
    headers: { ...CORS_HEADERS, ...cacheHeaders, "content-type": "application/json" },
  });
}
