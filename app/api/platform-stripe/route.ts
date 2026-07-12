import { NextRequest } from "next/server";
import { verifyPlatformWebhook, applyPlatformEvent } from "@/lib/platform-billing";

/**
 * The PLATFORM Stripe webhook (B3) — our own revenue events, entirely
 * separate from the per-tenant /api/stripe/webhook/[projectId] surface.
 * Signature-verified against PLATFORM_STRIPE_WEBHOOK_SECRET (fail-closed:
 * unset secret = every event rejected). Idempotent by construction: every
 * handler is a state SET keyed by ids in the event, so Stripe's at-least-once
 * delivery re-applies harmlessly.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!verifyPlatformWebhook(rawBody, req.headers.get("stripe-signature"))) {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const outcome = await applyPlatformEvent(event);
    return Response.json({ received: true, outcome });
  } catch (e) {
    // A real failure (DB down) must 500 so Stripe retries the delivery.
    console.error("platform-stripe webhook failed", e);
    return Response.json({ error: "handler failed" }, { status: 500 });
  }
}
