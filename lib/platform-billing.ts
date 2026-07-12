import "server-only";
import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { controlDb } from "@/db";
import { projects } from "@/db/schema";
import { stripeRequest, verifyStripeSignature, StripeError } from "./stripe";

/**
 * PLATFORM billing (B3) — OUR Stripe account collecting the per-project
 * subscriptions ($19 BYO / $29 managed, decided 2026-07-11). Entirely
 * separate from the per-tenant `stripe` connectors (Phase 15), which are the
 * tenants' own checkout; this module never touches connector secrets.
 *
 * Env (platform secrets, render.yaml sync:false):
 * - PLATFORM_STRIPE_SECRET_KEY      — the platform account's sk
 * - PLATFORM_STRIPE_WEBHOOK_SECRET  — whsec for /api/platform-stripe
 *
 * Prices self-provision via lookup keys on first use — the operator's only
 * setup is pasting the secret key. The webhook is the ONLY writer of
 * billingStatus; the UI reads, never guesses.
 */

export const PLAN_PRICING = {
  byo: { lookupKey: "agentx_byo_monthly", unitAmount: 1900, label: "AgentX project — bring your own infra" },
  managed: { lookupKey: "agentx_managed_monthly", unitAmount: 2900, label: "AgentX project — managed infra" },
} as const;

export type PaidPlan = keyof typeof PLAN_PRICING;

function platformKey(): string {
  const sk = process.env.PLATFORM_STRIPE_SECRET_KEY;
  if (!sk) {
    throw new Error(
      "PLATFORM_STRIPE_SECRET_KEY is not set — platform billing needs the platform Stripe account's secret key (tenant connectors are unaffected)",
    );
  }
  return sk;
}

// One resolve per process per plan — prices are immutable once created.
const priceCache = new Map<PaidPlan, string>();

/** The Stripe Price id for a plan — found by lookup key, created if absent. */
export async function ensurePlanPrice(plan: PaidPlan): Promise<string> {
  const cached = priceCache.get(plan);
  if (cached) return cached;
  const sk = platformKey();
  const { lookupKey, unitAmount, label } = PLAN_PRICING[plan];

  const found = await stripeRequest(sk, "GET", `/v1/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`);
  const existing = (found.data as { id?: string }[] | undefined)?.[0]?.id;
  if (existing) {
    priceCache.set(plan, existing);
    return existing;
  }

  const product = await stripeRequest(sk, "POST", "/v1/products", { name: label });
  if (typeof product.id !== "string") throw new StripeError("product response missing id", 0);
  const price = await stripeRequest(sk, "POST", "/v1/prices", {
    product: product.id,
    unit_amount: String(unitAmount),
    currency: "usd",
    "recurring[interval]": "month",
    lookup_key: lookupKey,
  });
  if (typeof price.id !== "string") throw new StripeError("price response missing id", 0);
  priceCache.set(plan, price.id);
  return price.id;
}

/**
 * A subscription-mode Checkout Session for one project. metadata.projectId is
 * the correlation key the webhook trusts (plus our own kind marker so tenant
 * events can never be confused for platform ones).
 */
export async function createSubscriptionCheckout(opts: {
  projectId: string;
  plan: PaidPlan;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const sk = platformKey();
  const price = await ensurePlanPrice(opts.plan);
  const session = await stripeRequest(sk, "POST", "/v1/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer_email: opts.customerEmail,
    client_reference_id: opts.projectId,
    "metadata[kind]": "platform_subscription",
    "metadata[projectId]": opts.projectId,
    "subscription_data[metadata][projectId]": opts.projectId,
  });
  if (typeof session.url !== "string") throw new StripeError("checkout session response missing url", 0);
  return { url: session.url };
}

/** Cancel a project's subscription (project delete / downgrade). 404 = gone = success. */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  try {
    await stripeRequest(platformKey(), "DELETE", `/v1/subscriptions/${subscriptionId}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return;
    throw e;
  }
}

export function verifyPlatformWebhook(rawBody: string, sigHeader: string | null): boolean {
  const secret = process.env.PLATFORM_STRIPE_WEBHOOK_SECRET;
  if (!secret) return false; // fail-closed: unverifiable = rejected
  return verifyStripeSignature(rawBody, sigHeader, secret);
}

/** Map Stripe's subscription status vocabulary onto ours. */
function mapSubscriptionStatus(s: string): "active" | "past_due" | "canceled" {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid" || s === "incomplete") return "past_due";
  return "canceled"; // canceled | incomplete_expired | paused
}

/**
 * Apply one verified platform event. Returns what it did (the webhook route
 * logs it; unknown/irrelevant events are acknowledged untouched). Token-cache
 * revalidation makes billing state changes take effect immediately — a
 * canceled project's surfaces go dark now, not in five minutes.
 */
export async function applyPlatformEvent(event: {
  type?: string;
  data?: { object?: Record<string, unknown> };
}): Promise<string> {
  const type = event.type ?? "";
  const obj = event.data?.object ?? {};

  if (type === "checkout.session.completed") {
    const meta = (obj.metadata ?? {}) as Record<string, string>;
    if (meta.kind !== "platform_subscription" || !meta.projectId) return "ignored (not a platform subscription)";
    await controlDb
      .update(projects)
      .set({
        stripeCustomerId: typeof obj.customer === "string" ? obj.customer : null,
        stripeSubscriptionId: typeof obj.subscription === "string" ? obj.subscription : null,
        billingStatus: "active",
      })
      .where(eq(projects.id, meta.projectId));
    revalidate(meta.projectId);
    return `activated billing for project ${meta.projectId}`;
  }

  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const subId = typeof obj.id === "string" ? obj.id : null;
    if (!subId) return "ignored (no subscription id)";
    const status =
      type === "customer.subscription.deleted"
        ? ("canceled" as const)
        : mapSubscriptionStatus(typeof obj.status === "string" ? obj.status : "canceled");
    const [row] = await controlDb
      .update(projects)
      .set({ billingStatus: status })
      .where(eq(projects.stripeSubscriptionId, subId))
      .returning({ id: projects.id });
    if (!row) return `ignored (no project holds subscription ${subId})`;
    revalidate(row.id);
    return `billing ${status} for project ${row.id}`;
  }

  return `ignored (${type || "untyped"})`;
}

function revalidate(projectId: string): void {
  try {
    revalidateTag("project-tokens");
    revalidateTag(`project:${projectId}`);
  } catch {
    // outside a request context (exercise) — the 5-min TTL covers it
  }
}
