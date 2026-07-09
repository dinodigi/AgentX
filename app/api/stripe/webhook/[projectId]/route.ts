import { NextRequest } from "next/server";
import { connectorSecret } from "@/lib/connectors";
import { verifyStripeSignature } from "@/lib/stripe";

/**
 * Inbound Stripe events (K3). The whsec signature is the ONLY authentication,
 * and the project identity comes ONLY from the URL path segment — session
 * metadata is never trusted for identity (K4's translation re-derives every
 * reference strictly within this project). The raw body is read BEFORE any
 * parsing: the signature covers the exact bytes on the wire.
 *
 * Verified events are acknowledged 200 {received:true} for ALL types — the
 * checkout.session.* → order-flip translation lands in K4. 400 on a bad
 * signature (Stripe's dashboard surfaces it and retries); 503 when the
 * signing secret isn't configured (registration hint in get_project_info).
 */

// Non-uuid path segments 404 before touching the DB (uuid column, else 22P02).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Stripe events are a few KB; a real one never approaches this. The endpoint is
// unauthenticated by design (Stripe can't hold a token), so an unbounded
// req.text() would let anyone OOM the shared process with one large body —
// cap the read instead.
const MAX_WEBHOOK_BYTES = 1 << 20; // 1 MiB

/** Read the body up to `max` bytes; null if it declares or streams past it. */
async function readBounded(req: NextRequest, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null; // honest-header fast reject
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      // Chunked/lying client: stop before buffering more.
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!UUID_RE.test(projectId)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Resolve the signing secret BEFORE buffering the body — an unknown or
  // unconfigured project (the anonymous-spray case) never reads a byte.
  // webhookSigning slot ONLY — never the sk (connectorSecret has no fallback
  // for named slots, so a missing whsec can't silently "verify" against it).
  const whsec = await connectorSecret(projectId, "stripe", "webhookSigning");
  if (!whsec) {
    return Response.json(
      { error: "Stripe webhook signing secret is not configured for this project" },
      { status: 503 },
    );
  }

  const raw = await readBounded(req, MAX_WEBHOOK_BYTES);
  if (raw === null) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), whsec)) {
    return Response.json({ error: "signature verification failed" }, { status: 400 });
  }

  let event: { type?: unknown };
  try {
    event = JSON.parse(raw) as { type?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON payload" }, { status: 400 });
  }

  // K4 translates checkout.session.* into order lifecycle flips; until then a
  // verified event is acknowledged so Stripe doesn't queue retries.
  return Response.json({
    received: true,
    type: typeof event.type === "string" ? event.type : null,
  });
}
