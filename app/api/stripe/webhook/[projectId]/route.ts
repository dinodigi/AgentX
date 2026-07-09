import { NextRequest } from "next/server";
import { connectorSecret } from "@/lib/connectors";
import { verifyStripeSignature, stripeAmountToMajor } from "@/lib/stripe";
import { getCollection } from "@/lib/collections";
import { updateEntryIf } from "@/lib/entries";
import { recordInboundDelivery } from "@/lib/webhook";
import { ValidationError } from "@/lib/validation";

/**
 * Inbound Stripe events (K3 + K4 translation). The whsec signature is the ONLY
 * authentication, and the project identity comes ONLY from the URL path
 * segment — session metadata is NEVER trusted for identity. K4 re-derives every
 * reference strictly within the path project: metadata.collection is resolved
 * inside this project, and the order flip's WHERE is scoped to the orders
 * collection's id, so a signed event whose metadata points at another tenant's
 * collection/entry is a harmless 200 no-op. The raw body is read AFTER the
 * connector check and under a size cap, and the signature covers the exact
 * bytes on the wire.
 *
 * Order flips go through the CAS helper gated on status == 'pending', so Stripe
 * retries (or a completed-then-async race) produce exactly one flip. A bad
 * signature is 400 (Stripe surfaces + retries); a missing signing secret is
 * 503; a transient DB failure on the flip is 500 so Stripe retries; every
 * other verified event is acknowledged 200.
 */

// Non-uuid path segments 404 before touching the DB (uuid column, else 22P02).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Checkout Session shape we read (only the fields the flip needs). */
interface StripeSession {
  id?: string;
  payment_status?: string;
  amount_total?: number;
  currency?: string;
  customer_email?: string;
  customer_details?: { email?: string };
  metadata?: { collection?: string; orderEntryId?: string };
}

/** Which lifecycle move a verified event drives, or null for unmapped types. */
type Move = "paid" | "expired" | "pending-noop" | null;
function mapEvent(type: string, paymentStatus: string | undefined): Move {
  switch (type) {
    case "checkout.session.completed":
      // 'paid' clears now; async methods (OXXO/SEPA/konbini) arrive 'unpaid'
      // and settle later via async_payment_succeeded — no flip yet.
      return paymentStatus === "paid" ? "paid" : "pending-noop";
    case "checkout.session.async_payment_succeeded":
      return "paid";
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed":
      return "expired"; // v1: 'expired' covers both expiry and async failure
    default:
      return null;
  }
}

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

  let event: { type?: unknown; data?: { object?: unknown } };
  try {
    event = JSON.parse(raw) as { type?: unknown; data?: { object?: unknown } };
  } catch {
    return Response.json({ error: "invalid JSON payload" }, { status: 400 });
  }
  const payload = event as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  const session = (event.data?.object ?? {}) as StripeSession;

  const move = mapEvent(type, session.payment_status);
  if (!move) {
    // Unmapped type — acknowledged, not logged (a Stripe account fires many
    // event types AgentX has no order semantics for).
    return Response.json({ received: true, type, ignored: "unmapped event type" });
  }

  // Correlation keys are UNTRUSTED. A foreign checkout on the same Stripe
  // account (or a K2-only session created before orders existed) carries no
  // AgentX order metadata — acknowledge without logging (not ours).
  const meta = session.metadata ?? {};
  if (!meta.collection || !meta.orderEntryId || !UUID_RE.test(meta.orderEntryId)) {
    return Response.json({ received: true, type, ignored: "no order metadata" });
  }

  // Resolve the sellable collection STRICTLY within the path project; it must
  // declare checkout.orders. Anything else (foreign/renamed/undeclared) is a
  // logged no-op — it referenced this project but isn't a live order mapping.
  const sellable = await getCollection(projectId, meta.collection);
  const orders = sellable?.checkout?.orders;
  const ordersColl = orders ? await getCollection(projectId, orders.collection) : null;
  if (!orders || !ordersColl) {
    return Response.json({ received: true, type, ignored: "collection does not map orders" });
  }

  const f = orders.fields;

  // Async payment still pending: no flip, but log so the pending order's wait
  // is visible.
  if (move === "pending-noop") {
    await recordInboundDelivery({
      projectId,
      collectionId: ordersColl.id,
      eventType: type,
      payload,
      status: "success",
      note: "async payment pending — order stays pending",
    });
    return Response.json({ received: true, type, order: "pending" });
  }

  // Build the flip. The CAS guard (status == 'pending') makes retries and the
  // completed→async race idempotent; the WHERE is scoped to ordersColl.id, so a
  // forged orderEntryId from another collection simply isn't found.
  const setData: Record<string, unknown> = { [f.status]: move };
  if (move === "paid") {
    if (session.id) setData[f.sessionId] = session.id;
    if (f.total && typeof session.amount_total === "number" && session.currency) {
      setData[f.total] = stripeAmountToMajor(session.amount_total, session.currency);
    }
    if (f.customerEmail) {
      const email = session.customer_details?.email ?? session.customer_email;
      if (email) setData[f.customerEmail] = email;
    }
  }

  let result;
  try {
    result = await updateEntryIf(projectId, ordersColl, meta.orderEntryId, {
      if: [{ field: f.status, op: "eq", value: "pending" }],
      data: setData,
      actor: { type: "delivery" },
    });
  } catch (e) {
    if (e instanceof ValidationError) {
      // PERMANENT: the flip data violates a constraint the operator put on an
      // orders field (a bound, integer, unique, or a since-narrowed enum).
      // Retrying can't fix it — log a failed delivery so the operator sees it
      // and 200 so Stripe STOPS (a 500 would retry the same doomed event for
      // days). Define-time validation blocks the common cases; this is the net.
      await recordInboundDelivery({ projectId, collectionId: ordersColl.id, eventType: type, payload, status: "failed", note: e.message });
      return Response.json({ received: true, type, error: "order write rejected", reason: e.message });
    }
    // Genuinely transient (DB) failure — 500 so Stripe retries.
    return Response.json({ error: "could not record order" }, { status: 500 });
  }

  if (result.ok) {
    await recordInboundDelivery({ projectId, collectionId: ordersColl.id, eventType: type, payload, status: "success" });
    return Response.json({ received: true, type, order: move });
  }
  // conflict = already flipped (a prior retry won) → idempotent success no-op.
  // not_found = the order id isn't in this collection (forged/foreign) → logged
  // failure, but still 200 so Stripe stops retrying a request we can't satisfy.
  await recordInboundDelivery({
    projectId,
    collectionId: ordersColl.id,
    eventType: type,
    payload,
    status: result.reason === "conflict" ? "success" : "failed",
    note: result.reason,
  });
  return Response.json({ received: true, type, noop: result.reason });
}
