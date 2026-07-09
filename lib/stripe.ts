/**
 * Stripe via plain fetch — no SDK. Same idiom as the Resend connector: pinned
 * API version, form-encoded bodies, secret key from the encrypted connector.
 * The base URL comes from STRIPE_API_BASE so the smoke harness can point the
 * whole surface at an in-process mock (K2b). Inbound webhook signature
 * verification is added in K3.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_API_BASE = process.env.STRIPE_API_BASE || "https://api.stripe.com";

/** Pinned so a Stripe API change can't silently alter response shapes. */
export const STRIPE_VERSION = "2024-06-20";

/** A Stripe API rejection — carries Stripe's own message + HTTP status. */
export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** One form-encoded request to Stripe's REST API. Throws StripeError on non-2xx. */
export async function stripeRequest(
  sk: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  formParams?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sk}`,
    "Stripe-Version": STRIPE_VERSION,
  };
  let body: string | undefined;
  if (formParams) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(formParams).toString();
  }
  let res: Response;
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Transport failure (down/unreachable/timed out) is an upstream fault, not
    // an internal one — raise StripeError so callers map it to 502 E_UPSTREAM.
    const name = (e as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new StripeError(timedOut ? "request timed out" : "API unreachable", 0);
  }
  const json = (await res.json().catch(() => null)) as
    | { error?: { message?: string } }
    | Record<string, unknown>
    | null;
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? `Stripe HTTP ${res.status}`;
    throw new StripeError(msg, res.status);
  }
  // A 2xx whose body can't be read (reset/stall mid-body, proxy garbage) is an
  // upstream fault — NOT a success with empty fields.
  if (json === null) throw new StripeError("unreadable response body", res.status);
  return json as Record<string, unknown>;
}

/**
 * Verify a Stripe-Signature header against the raw request bytes (K3) — the
 * inbound mirror of the outbound scheme in lib/webhook.ts:
 *   Stripe-Signature: t=<unix>,v1=<hex hmac of `${t}.${rawBody}`>[,v1=…]
 * Multiple v1 entries appear during signing-secret rotation — ANY match
 * verifies. Comparisons are length-checked timingSafeEqual (it throws on
 * unequal lengths, and a length oracle is itself a leak).
 */
export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string,
  toleranceSec = 300,
): boolean {
  if (!sigHeader) return false;
  let t: number | null = null;
  const v1s: string[] = [];
  for (const part of sigHeader.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) v1s.push(v);
  }
  if (t === null || v1s.length === 0) return false;
  // Freshness bound: a replayed capture outside the window fails even with a
  // valid signature (the timestamp is inside the signed payload).
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"),
    "utf8",
  );
  return v1s.some((v) => {
    const candidate = Buffer.from(v, "utf8");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

export interface CheckoutLineItem {
  price: string; // a Stripe Price id (price_…)
  quantity: number;
}

/**
 * Stripe amounts are in the smallest currency unit. Zero-decimal currencies
 * (JPY, KRW, …) are already whole units — dividing by 100 would understate by
 * 100x (openMinor #8). We don't store currency, so convert to the human amount
 * here using Stripe's own zero-decimal set; everything else is 2-decimal.
 */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf",
  "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function stripeAmountToMajor(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? amount : amount / 100;
}

/**
 * Create a payment-mode Checkout Session. Amounts come ONLY from the server-side
 * Price ids — the client never sends money values. metadata/client_reference_id
 * carry the correlation keys the inbound webhook re-derives against the path
 * project (never projectId — the URL path is the sole project authority).
 */
export async function createCheckoutSession(
  sk: string,
  opts: {
    lineItems: CheckoutLineItem[];
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    clientReferenceId?: string;
  },
): Promise<{ id: string; url: string }> {
  const params: Record<string, string> = {
    mode: "payment",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  };
  opts.lineItems.forEach((li, i) => {
    params[`line_items[${i}][price]`] = li.price;
    params[`line_items[${i}][quantity]`] = String(li.quantity);
  });
  if (opts.clientReferenceId) params.client_reference_id = opts.clientReferenceId;
  for (const [k, v] of Object.entries(opts.metadata ?? {})) params[`metadata[${k}]`] = v;

  const session = await stripeRequest(sk, "POST", "/v1/checkout/sessions", params);
  // Never hand a storefront {url: "undefined"} — a malformed 2xx is upstream.
  if (typeof session.id !== "string" || typeof session.url !== "string") {
    throw new StripeError("checkout session response is missing id/url", 0);
  }
  return { id: session.id, url: session.url };
}

/** The four order-lifecycle events the webhook translates (K3/K4). */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
] as const;

/**
 * Register a webhook endpoint (K5) — one-click provisioning so the operator
 * never copy-pastes a whsec. Stripe returns the signing secret ONLY here, at
 * creation, so the caller must persist `secret` immediately.
 */
export async function createWebhookEndpoint(
  sk: string,
  url: string,
): Promise<{ id: string; secret: string }> {
  const params: Record<string, string> = { url };
  WEBHOOK_EVENTS.forEach((e, i) => (params[`enabled_events[${i}]`] = e));
  const ep = await stripeRequest(sk, "POST", "/v1/webhook_endpoints", params);
  if (typeof ep.id !== "string" || typeof ep.secret !== "string") {
    throw new StripeError("webhook endpoint response is missing id/secret", 0);
  }
  return { id: ep.id, secret: ep.secret };
}

/** Read a webhook endpoint's status (K5 health) — 'enabled' | 'disabled', or null if gone. */
export async function getWebhookEndpoint(sk: string, id: string): Promise<{ status: string } | null> {
  try {
    const ep = await stripeRequest(sk, "GET", `/v1/webhook_endpoints/${id}`);
    return { status: typeof ep.status === "string" ? ep.status : "unknown" };
  } catch (e) {
    // A deleted endpoint is a 404 → report "missing", not an error.
    if (e instanceof StripeError && e.status === 404) return null;
    throw e;
  }
}

/** Best-effort delete on disconnect (K5) — a 404 (already gone) is success. */
export async function deleteWebhookEndpoint(sk: string, id: string): Promise<void> {
  try {
    await stripeRequest(sk, "DELETE", `/v1/webhook_endpoints/${id}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return;
    throw e;
  }
}
