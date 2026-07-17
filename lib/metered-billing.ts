import "server-only";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { controlDb } from "@/db";
import { neonUsageDaily, projects } from "@/db/schema";
import { stripeRequest, StripeError } from "./stripe";
import { effectiveMeteredRates } from "./platform-settings";

/**
 * Track 4d: METERED billing rails on top of the flat platform subscription.
 *
 * Model (usage-metering decision, 2026-07-17): the flat plan price stays the
 * base; two classic metered subscription items ride the same subscription —
 *   - compute: Neon CU-hours (compute_time_seconds / 3600)
 *   - storage: Neon GB-months (data_storage_bytes_hour — exact byte-hour
 *     accounting, not point-in-time size)
 * Quantities come from the 4b snapshots; we continuously `set` month-to-date
 * usage after each Neon sweep (idempotent — Stripe invoices whatever was last
 * set when the tenant's cycle closes). Caps (4a) stay the hard ceiling ABOVE
 * the meter.
 *
 * INERT BY DEFAULT: everything no-ops until the operator sets METERED_RATES —
 * JSON env, cents per unit, e.g. {"computeCentsPerCuHour":12,
 * "storageCentsPerGbMonth":8}. Rates are a pricing decision (≥ our Neon
 * COGS), not a code default.
 *
 * Known v1 approximation: Neon's consumption period (their billing month) and
 * each tenant's Stripe cycle (subscription anniversary) don't align exactly —
 * month-to-date totals reset on Neon's clock. Set rates with that in mind;
 * refine to period-sliced deltas if it ever matters.
 */

export interface MeteredRates {
  computeCentsPerCuHour: number;
  storageCentsPerGbMonth: number;
}

const METERED_PRICES = {
  compute: { lookupKey: "agentx_metered_compute_cuh", label: "AgentX managed compute (CU-hour)" },
  storage: { lookupKey: "agentx_metered_storage_gbm", label: "AgentX managed storage (GB-month)" },
} as const;
type MeteredDim = keyof typeof METERED_PRICES;

function platformKey(): string {
  const sk = process.env.PLATFORM_STRIPE_SECRET_KEY;
  if (!sk) throw new Error("PLATFORM_STRIPE_SECRET_KEY is not set — metered billing needs the platform Stripe key");
  return sk;
}

// Same one-resolve-per-process pattern as ensurePlanPrice.
const meteredPriceCache = new Map<MeteredDim, string>();

/** The metered Price id for a dimension — lookup-key idempotent, created if absent. */
export async function ensureMeteredPrice(dim: MeteredDim, rates: MeteredRates): Promise<string> {
  const cached = meteredPriceCache.get(dim);
  if (cached) return cached;
  const sk = platformKey();
  const { lookupKey, label } = METERED_PRICES[dim];

  const found = await stripeRequest(sk, "GET", `/v1/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`);
  const existing = (found.data as { id?: string }[] | undefined)?.[0]?.id;
  if (existing) {
    meteredPriceCache.set(dim, existing);
    return existing;
  }

  const product = await stripeRequest(sk, "POST", "/v1/products", { name: label });
  if (typeof product.id !== "string") throw new StripeError("product response missing id", 0);
  const unitAmount = dim === "compute" ? rates.computeCentsPerCuHour : rates.storageCentsPerGbMonth;
  const price = await stripeRequest(sk, "POST", "/v1/prices", {
    product: product.id,
    unit_amount: String(unitAmount),
    currency: "usd",
    "recurring[interval]": "month",
    "recurring[usage_type]": "metered",
    lookup_key: lookupKey,
  });
  if (typeof price.id !== "string") throw new StripeError("price response missing id", 0);
  meteredPriceCache.set(dim, price.id);
  return price.id;
}

/** The subscription's metered item ids, attaching any that are missing. */
async function ensureMeteredItems(
  subscriptionId: string,
  rates: MeteredRates,
): Promise<Record<MeteredDim, string>> {
  const sk = platformKey();
  const prices: Record<MeteredDim, string> = {
    compute: await ensureMeteredPrice("compute", rates),
    storage: await ensureMeteredPrice("storage", rates),
  };
  const items = await stripeRequest(sk, "GET", `/v1/subscription_items?subscription=${subscriptionId}&limit=10`);
  const list = (items.data as { id: string; price?: { id?: string } }[] | undefined) ?? [];
  const out = {} as Record<MeteredDim, string>;
  for (const dim of ["compute", "storage"] as const) {
    const have = list.find((i) => i.price?.id === prices[dim]);
    if (have) {
      out[dim] = have.id;
      continue;
    }
    const created = await stripeRequest(sk, "POST", "/v1/subscription_items", {
      subscription: subscriptionId,
      price: prices[dim],
      // Metered items take no quantity; don't invoice mid-cycle for the attach.
      proration_behavior: "none",
    });
    if (typeof created.id !== "string") throw new StripeError("subscription_item response missing id", 0);
    out[dim] = created.id;
  }
  return out;
}

/** Month-to-date usage per managed project from the latest 4b snapshot this month (UTC). */
export async function monthToDateUsage(): Promise<
  Map<string, { cuHours: number; gbMonths: number }>
> {
  const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
  const rows = await controlDb
    .selectDistinctOn([neonUsageDaily.projectId], {
      projectId: neonUsageDaily.projectId,
      computeTimeSeconds: neonUsageDaily.computeTimeSeconds,
      dataStorageBytesHour: neonUsageDaily.dataStorageBytesHour,
      syntheticStorageSizeBytes: neonUsageDaily.syntheticStorageSizeBytes,
    })
    .from(neonUsageDaily)
    .where(gte(neonUsageDaily.day, monthStart))
    .orderBy(neonUsageDaily.projectId, sql`${neonUsageDaily.capturedAt} DESC`);
  const HOURS_PER_MONTH = 730;
  return new Map(
    rows.map((r) => {
      const byteHours = Number(r.dataStorageBytesHour);
      // Exact byte-hour accounting when Neon populates it; on org plans where
      // the accumulator is 0 (verified live), bill the current synthetic size
      // as the month's GB — a defensible stand-in until byte-hours appear.
      const gbMonths =
        byteHours > 0
          ? Math.ceil(byteHours / 1024 ** 3 / HOURS_PER_MONTH)
          : Math.ceil(Number(r.syntheticStorageSizeBytes) / 1024 ** 3);
      return [r.projectId, { cuHours: Math.ceil(Number(r.computeTimeSeconds) / 3600), gbMonths }];
    }),
  );
}

/**
 * Report month-to-date metered usage for every billable managed project.
 * Runs after each Neon sweep (drain); `action=set` makes re-runs idempotent.
 * Returns how many projects were reported; 0 when inert (no METERED_RATES).
 */
export async function reportMeteredUsage(): Promise<number> {
  // Console Platform Settings first, METERED_RATES env fallback.
  const rates = await effectiveMeteredRates();
  if (!rates) return 0; // inert until the operator sets rates

  const billable = await controlDb
    .select({ id: projects.id, subscriptionId: projects.stripeSubscriptionId })
    .from(projects)
    .where(
      and(eq(projects.plan, "managed"), eq(projects.billingStatus, "active"), isNotNull(projects.stripeSubscriptionId)),
    );
  if (billable.length === 0) return 0;

  const usage = await monthToDateUsage();
  const sk = platformKey();
  const now = Math.floor(Date.now() / 1000);
  let reported = 0;
  for (const b of billable) {
    const u = usage.get(b.id);
    if (!u || !b.subscriptionId) continue;
    try {
      const items = await ensureMeteredItems(b.subscriptionId, rates);
      await stripeRequest(sk, "POST", `/v1/subscription_items/${items.compute}/usage_records`, {
        quantity: String(u.cuHours),
        timestamp: String(now),
        action: "set",
      });
      await stripeRequest(sk, "POST", `/v1/subscription_items/${items.storage}/usage_records`, {
        quantity: String(u.gbMonths),
        timestamp: String(now),
        action: "set",
      });
      reported++;
    } catch (e) {
      // One tenant's Stripe hiccup must not stop the sweep; next drain retries.
      console.error(`metered usage report failed for project ${b.id}`, e instanceof Error ? e.message : e);
    }
  }
  return reported;
}
