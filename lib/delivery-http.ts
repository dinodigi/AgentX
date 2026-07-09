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
): Response {
  const code = CODE_BY_STATUS[status] ?? "E_INTERNAL";
  return corsJson(
    { error: message, code, ...(issues && issues.length > 0 ? { issues: issues.slice(0, 20) } : {}) },
    { ...init, status },
  );
}

/**
 * 200 with a strong ETag, or 304 when If-None-Match matches. cache-control
 * no-cache = "revalidate every time": clients and CDNs skip the body transfer
 * on a hit but never serve stale content (entries change without URL busts).
 */
export function cachedJson(req: NextRequest, body: unknown): Response {
  const json = JSON.stringify(body);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 32);
  const etag = `"${hash}"`;
  const cacheHeaders = { etag, "cache-control": "no-cache" };
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
