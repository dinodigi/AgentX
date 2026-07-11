import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { tenantDb } from "@/lib/data-plane";
import { entries } from "@/db/schema";
import { bearerFrom, resolveProjectId } from "@/lib/tokens";
import { getCollection } from "@/lib/collections";
import { connectorSecret } from "@/lib/connectors";
import { createCheckoutSession, StripeError, type CheckoutLineItem } from "@/lib/stripe";
import { createEntry, publicFields } from "@/lib/entries";
import { matchesClauses } from "@/lib/query";
import type { WhereItem } from "@/lib/query";
import { rateLimit } from "@/lib/ratelimit";
import { corsJson, deliveryError } from "@/lib/delivery-http";
import { preflight } from "@/lib/cors";

/**
 * Checkout (K2b) — turn a cart of entry ids + quantities into a Stripe Checkout
 * Session. The client NEVER sends amounts or Price ids: what is sellable and at
 * what price is server-side content (priceField). The read gate is identical to
 * a public delivery read (access.read is pinned public at define time, so
 * publicFilter is the complete row gate), and a miss is indistinguishable
 * whether the entry is absent or filtered — checkout can never probe existence
 * for anything a delivery GET would hide.
 *
 *   POST /v1/checkout  { collection, items:[{id, quantity}], successUrl?, cancelUrl? }
 */

// Non-uuid ids 404 as misses before touching the DB (entries.id is a uuid
// column — an unfiltered inArray would raise 22P02 as an unhandled 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  collection: z.string(),
  items: z.array(z.object({ id: z.string(), quantity: z.number().int().min(1).max(100) })).min(1).max(100),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

/** A request override is honored only if it shares the configured URL's origin. */
function resolveUrl(override: string | undefined, configured: string): string | null {
  if (!override) return configured;
  try {
    return new URL(override).origin === new URL(configured).origin ? override : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const token = bearerFrom(req.headers.get("authorization"));
  const projectId = token ? await resolveProjectId(token) : null;
  if (!projectId) return deliveryError(401, "invalid or missing project token");

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = await rateLimit(`${projectId}:${ip}`);
  if (!rl.allowed) {
    return deliveryError(429, "too many checkout requests — try again shortly", {
      headers: { "retry-after": String(rl.retryAfterSec) },
    });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (e) {
    return deliveryError(422, e instanceof z.ZodError ? "invalid checkout body — needs {collection, items:[{id, quantity}]}" : "invalid JSON body");
  }

  const collection = await getCollection(projectId, body.collection);
  // Read-gate parity with GET /v1/{collection}: absent and zero-public-fields
  // are ONE indistinguishable 404, checked BEFORE the sellable 422 — otherwise
  // checkout would confirm the existence of collections the read surface hides.
  if (!collection || publicFields(collection).length === 0) return deliveryError(404, "not found");
  const checkout = collection.checkout;
  if (!checkout) return deliveryError(422, `collection "${body.collection}" is not sellable (no checkout config)`);

  const successUrl = resolveUrl(body.successUrl, checkout.successUrl);
  const cancelUrl = resolveUrl(body.cancelUrl, checkout.cancelUrl);
  if (!successUrl || !cancelUrl) {
    return deliveryError(422, "successUrl/cancelUrl override must share the configured URL's origin");
  }

  // Load the requested entries, scoped to this collection. Non-uuid ids can't
  // exist — drop them before the query so they fall into the same
  // indistinguishable per-item miss below instead of a DB type error.
  const ids = [...new Set(body.items.map((i) => i.id).filter((id) => UUID_RE.test(id)))];
  const rows = ids.length
    ? await (await tenantDb(projectId))
        .select({ id: entries.id, data: entries.data })
        .from(entries)
        .where(and(eq(entries.collectionId, collection.id), inArray(entries.id, ids)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r.data]));
  const pf = (collection.publicFilter as WhereItem[] | null) ?? [];

  const lineItems: CheckoutLineItem[] = [];
  for (let n = 0; n < body.items.length; n++) {
    const { id, quantity } = body.items[n];
    const data = byId.get(id);
    // Absent OR row-gated ⇒ one indistinguishable message (never confirm existence).
    if (!data || (pf.length > 0 && !matchesClauses(collection.fields, pf, data))) {
      return deliveryError(422, `items[${n}]: entry ${id} not found or not available`);
    }
    const price = data[checkout.priceField];
    if (typeof price !== "string" || !/^price_/.test(price)) {
      return deliveryError(422, `items[${n}]: "${body.collection}.${checkout.priceField}" is not a Stripe Price id (price_…)`);
    }
    lineItems.push({ price, quantity });
  }

  const sk = await connectorSecret(projectId, "stripe");
  if (!sk) return deliveryError(503, "Stripe connector is not configured for this project");

  // K4: when orders is declared, record a pending order BEFORE creating the
  // session, so its id can travel as the correlation key the webhook re-derives.
  // If session creation then fails, the pending row simply never pays (visible
  // in admin, harmless) — better than a paid session with no order to flip.
  const metadata: Record<string, string> = { collection: body.collection };
  let clientReferenceId: string | undefined;
  if (checkout.orders) {
    const ordersColl = await getCollection(projectId, checkout.orders.collection);
    if (!ordersColl) {
      // The mapping was validated at define time; a missing target now is an
      // operator error, not a buyer-repairable one.
      return deliveryError(500, "orders collection is misconfigured");
    }
    const f = checkout.orders.fields;
    // Only fields the pending order can actually fill: status + the cart items.
    // sessionId/total/customerEmail arrive on the paid flip — leaving sessionId
    // ABSENT (NULL) rather than "" so a unique index on it never collides across
    // pending rows. validateCheckoutOrders guarantees these are not required.
    const orderData: Record<string, unknown> = { [f.status]: "pending" };
    if (f.items) orderData[f.items] = JSON.stringify(body.items);
    try {
      // Anonymous buyer: identity:{user:null} makes a beforeCreate transform on
      // the orders collection have owner/org STRIPPED (a hook can't inject
      // ownership on the order it can't otherwise set), same as an anonymous POST.
      const order = await createEntry(projectId, ordersColl, orderData, {
        actor: { type: "delivery" },
        identity: { user: null },
      });
      metadata.orderEntryId = order.id;
      clientReferenceId = order.id;
    } catch {
      return deliveryError(500, "could not open an order for this checkout");
    }
  }

  try {
    const session = await createCheckoutSession(sk, {
      lineItems,
      successUrl,
      cancelUrl,
      metadata,
      clientReferenceId,
    });
    return corsJson({ url: session.url, sessionId: session.id }, { status: 201 });
  } catch (e) {
    if (e instanceof StripeError) return deliveryError(502, `Stripe: ${e.message}`);
    return deliveryError(500, "internal error");
  }
}

export function OPTIONS() {
  return preflight();
}
