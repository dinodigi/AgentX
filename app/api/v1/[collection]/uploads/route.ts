import { NextRequest } from "next/server";
import { bearerFrom, resolveProjectId } from "@/lib/tokens";
import { getCollection } from "@/lib/collections";
import { gateCreate } from "@/lib/access-rules";
import { rateLimit } from "@/lib/ratelimit";
import { uploadAsset } from "@/lib/r2";
import { ValidationError } from "@/lib/validation";
import { preflight } from "@/lib/cors";
import { corsJson, deliveryError } from "@/lib/delivery-http";

/**
 * Public upload intake: POST /v1/{collection}/uploads with multipart/form-data
 * ("attach a photo to your booking"). Gated exactly like a form submission —
 * the collection must accept creates from this caller AND declare an asset
 * field worth attaching to. Size/type limits enforced at the uploadAsset
 * choke point (subsystem 02). Returns {id, url}; the form submission then
 * references the id in its asset field.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ collection: string }> },
) {
  const { collection: name } = await params;
  const token = bearerFrom(req.headers.get("authorization"));
  const projectId = token ? await resolveProjectId(token) : null;
  if (!projectId) return deliveryError(401, "invalid or missing project token");
  const collection = await getCollection(projectId, name);
  if (!collection) return deliveryError(404, "not found");

  if (!collection.fields.some((f) => f.type === "asset")) {
    return deliveryError(
      403,
      `"${name}" has no asset fields — there is nothing an upload could attach to`,
    );
  }
  const gate = await gateCreate(projectId, collection, req.headers.get("x-user-token"));
  if (!gate.ok) return deliveryError(gate.status, gate.error);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limit = rateLimit(`${projectId}:${ip}`);
  if (!limit.allowed) {
    return deliveryError(429, "too many uploads — try again shortly", {
      headers: { "retry-after": String(limit.retryAfterSec) },
    });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return deliveryError(400, 'expected multipart/form-data with a "file" part');
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return deliveryError(422, 'multipart body needs a "file" part');
  }

  try {
    const asset = await uploadAsset({
      projectId,
      filename: file.name || "upload",
      contentType: file.type || "application/octet-stream",
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return corsJson({ id: asset.id, url: asset.url }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) return deliveryError(422, e.message);
    return deliveryError(500, "upload failed");
  }
}

export function OPTIONS() {
  return preflight();
}

/** /uploads is POST-only; a stray GET gets the enveloped 404, not a bare 405. */
export function GET() {
  return deliveryError(404, "not found — /uploads accepts POST multipart/form-data only");
}
