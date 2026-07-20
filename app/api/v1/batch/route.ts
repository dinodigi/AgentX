import { NextRequest } from "next/server";
import { bearerFrom, resolveDeliveryToken } from "@/lib/tokens";
import { rateLimit } from "@/lib/ratelimit";
import { preflight } from "@/lib/cors";
import { corsJson, deliveryError } from "@/lib/delivery-http";
import { readBounded, MAX_DELIVERY_BODY_BYTES } from "@/lib/http";
import { GET as listGET } from "../[collection]/route";

/**
 * Batch delivery reads (v2 Track 3a — from the developer review): one POST
 * carrying several collection queries, answered together. Built as a
 * MULTIPLEXER over the real list handler — each sub-query becomes a synthetic
 * GET into `GET /v1/{collection}`, so projection, publicFilter/identity gates,
 * relation/asset resolution, and search limits are IDENTICAL by construction.
 *
 * WHEN TO USE (documented for agents): authenticated dashboards — a user's
 * own varied, uncacheable data, where one round trip beats five. PUBLIC pages
 * should keep individual GETs: a POST can't be edge-cached, so batching them
 * would send every section to origin while GETs ride the CDN for free.
 *
 *   POST /v1/batch { queries: [{ collection, params? }, ...] }
 *     params: the same key/values the list GET takes in its query string
 *     (limit, offset, sort, select, expand, include, q, locale, field filters).
 *   → 200 { results: [{ collection, status, ...body }, ...] }  (per-item status)
 */

const MAX_BATCH_QUERIES = 10;

export async function POST(req: NextRequest) {
  const auth = await resolveDeliveryToken(bearerFrom(req.headers.get("authorization")));
  if (!auth.ok) return deliveryError(401, auth.error, undefined, undefined, auth.code);
  const projectId = auth.projectId;

  // Same per-IP window as the other limited surfaces; one batch = one hit
  // (bounded at MAX_BATCH_QUERIES sub-queries), attributed for metering.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = await rateLimit(`${projectId}:${ip}`, { projectId });
  if (!rl.allowed) {
    return deliveryError(429, "too many requests — try again shortly", {
      headers: { "retry-after": String(rl.retryAfterSec) },
    });
  }

  const raw = await readBounded(req, MAX_DELIVERY_BODY_BYTES);
  if (raw === null) return deliveryError(413, "request body too large");
  let body: { queries?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return deliveryError(400, "invalid JSON body");
  }
  const queries = body?.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    return deliveryError(422, 'body must be { queries: [{ collection, params? }, ...] }');
  }
  if (queries.length > MAX_BATCH_QUERIES) {
    return deliveryError(422, `at most ${MAX_BATCH_QUERIES} queries per batch`);
  }

  const results = await Promise.all(
    queries.map(async (q) => {
      const spec = q as { collection?: unknown; params?: Record<string, unknown> };
      if (typeof spec?.collection !== "string" || spec.collection.length === 0) {
        return { collection: null, status: 422, error: "each query needs a collection", code: "E_VALIDATION" };
      }
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(spec.params ?? {})) {
        if (v != null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
          qs.set(k, String(v));
        }
      }
      // Synthetic GET into the REAL handler — original headers carry the
      // bearer token + x-user-token, so identity gating matches a direct call.
      const url = `${new URL(req.url).origin}/api/v1/${encodeURIComponent(spec.collection)}${qs.size > 0 ? `?${qs}` : ""}`;
      const sub = new NextRequest(url, { headers: req.headers });
      try {
        const res = await listGET(sub, { params: Promise.resolve({ collection: spec.collection }) });
        if (!res) return { collection: spec.collection, status: 500, error: "internal error", code: "E_INTERNAL" };
        const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { collection: spec.collection, status: res.status, ...parsed };
      } catch {
        return { collection: spec.collection, status: 500, error: "internal error", code: "E_INTERNAL" };
      }
    }),
  );

  // Per-item statuses; the envelope is 200 (partial failure is data, like bulk).
  return corsJson({ results });
}

export function OPTIONS() {
  return preflight();
}
