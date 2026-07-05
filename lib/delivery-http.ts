import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { CORS_HEADERS } from "./cors";
import type { ErrorCode } from "./error-codes";

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
};

export function deliveryError(
  status: number,
  message: string,
  init?: ResponseInit,
): Response {
  const code = CODE_BY_STATUS[status] ?? "E_INTERNAL";
  return corsJson({ error: message, code }, { ...init, status });
}

/**
 * 200 with a strong ETag, or 304 when If-None-Match matches. cache-control
 * no-cache = "revalidate every time": clients and CDNs skip the body transfer
 * on a hit but never serve stale content (entries change without URL busts).
 */
export function cachedJson(req: NextRequest, body: unknown): Response {
  const json = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(json).digest("hex").slice(0, 32)}"`;
  const cacheHeaders = { etag, "cache-control": "no-cache" };
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ...CORS_HEADERS, ...cacheHeaders } });
  }
  return new Response(json, {
    status: 200,
    headers: { ...CORS_HEADERS, ...cacheHeaders, "content-type": "application/json" },
  });
}
