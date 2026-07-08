import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { parseTransformParams, ensureDerivative, isTransformable } from "@/lib/image-transform";
import { CORS_HEADERS, preflight } from "@/lib/cors";
import { deliveryError } from "@/lib/delivery-http";
import { ValidationError } from "@/lib/entries";

/**
 * On-demand image transform (J1) — PUBLIC (no auth header; URLs are directly
 * embeddable, and the original asset is already public). Resolves the asset by
 * its (unguessable) uuid, resizes/encodes via sharp into an R2-cached
 * derivative, then 302s to the derivative's public URL with a 1-year immutable
 * cache. Only raster images transform; svg/non-image → 422.
 *
 *   GET /v1/assets/{id}/image?w=&h=&fit=cover|inside&format=webp|jpeg
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return deliveryError(404, "not found");

  const [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!asset) return deliveryError(404, "not found");
  if (!isTransformable(asset.contentType)) {
    return deliveryError(422, `asset ${id} is not a transformable raster image (contentType: ${asset.contentType})`);
  }

  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  let tp;
  try {
    tp = parseTransformParams(query);
  } catch (e) {
    if (e instanceof ValidationError) return deliveryError(422, e.message);
    throw e;
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const result = await ensureDerivative(asset, tp, ip);
  if (!result.ok) {
    return deliveryError(
      result.status,
      result.error,
      result.retryAfterSec ? { headers: { "retry-after": String(result.retryAfterSec) } } : undefined,
    );
  }

  return new Response(null, {
    status: 302,
    headers: {
      ...CORS_HEADERS,
      location: `${process.env.R2_PUBLIC_BASE_URL}/${result.key}`,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

export function OPTIONS() {
  return preflight();
}
