import "server-only";
import { eq } from "drizzle-orm";
import { unstable_cache, revalidateTag } from "next/cache";
import { controlDb } from "@/db";
import { platformSettings } from "@/db/schema";
import { SANDBOX_CAPS, PAID_CAPS } from "./caps-defaults";
import type { MeteredRates } from "./metered-billing";

/**
 * Operator-editable platform configuration — the console's Platform Settings
 * page writes here so caps and metered rates are managed in the UI instead of
 * env vars / code constants. Reads are cached (tag: platform-settings) and
 * revalidated on write, so a saved change takes effect immediately without a
 * per-request control-DB read on the hot write path.
 *
 * Keys:
 *  - "caps.sandbox" / "caps.paid": PARTIAL overrides of the code defaults
 *    (unknown fields ignored, non-positive numbers ignored — fail toward the
 *    shipped defaults, never toward uncapped).
 *  - "meteredRates": {computeCentsPerCuHour, storageCentsPerGbMonth} —
 *    overrides the METERED_RATES env; both absent = metered billing inert.
 */

export interface CapSet {
  entries: number;
  collections: number;
  assetBytes: number;
  dataBytes: number;
}

// Plain object, NOT a Map — unstable_cache round-trips through JSON, and a
// Map deserializes to {} on cache hits.
async function readAll(): Promise<Record<string, Record<string, unknown>>> {
  const rows = await controlDb.select().from(platformSettings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// TTL matters beyond freshness: revalidateTag only reaches THIS instance's
// cache — with N app instances, the other N-1 converge via the 60s window.
const cachedAll = unstable_cache(readAll, ["platform-settings"], {
  tags: ["platform-settings"],
  revalidate: 60,
});

function mergeCaps(base: CapSet, override: Record<string, unknown> | undefined): CapSet {
  if (!override) return base;
  const out = { ...base };
  for (const k of ["entries", "collections", "assetBytes", "dataBytes"] as const) {
    const v = Number(override[k]);
    if (Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
  }
  return out;
}

/** Effective caps per tier: code defaults + operator overrides. */
export async function effectiveCaps(): Promise<{ sandbox: CapSet; paid: CapSet }> {
  const all = await cachedAll();
  return {
    sandbox: mergeCaps(SANDBOX_CAPS, all["caps.sandbox"]),
    paid: mergeCaps(PAID_CAPS, all["caps.paid"]),
  };
}

/** Effective metered rates: DB setting first, METERED_RATES env fallback, else null (inert). */
export async function effectiveMeteredRates(): Promise<MeteredRates | null> {
  const all = await cachedAll();
  const fromDb = all["meteredRates"];
  if (fromDb) {
    const compute = Number(fromDb.computeCentsPerCuHour);
    const storage = Number(fromDb.storageCentsPerGbMonth);
    if (Number.isFinite(compute) && Number.isFinite(storage) && compute >= 0 && storage >= 0) {
      return { computeCentsPerCuHour: compute, storageCentsPerGbMonth: storage };
    }
  }
  const raw = process.env.METERED_RATES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const compute = Number(parsed.computeCentsPerCuHour);
    const storage = Number(parsed.storageCentsPerGbMonth);
    if (!Number.isFinite(compute) || !Number.isFinite(storage) || compute < 0 || storage < 0) return null;
    return { computeCentsPerCuHour: compute, storageCentsPerGbMonth: storage };
  } catch {
    console.error("METERED_RATES is set but not valid JSON — metered billing stays off");
    return null;
  }
}

export async function getSetting(key: string): Promise<Record<string, unknown> | null> {
  const all = await cachedAll();
  return all[key] ?? null;
}

export async function setSetting(key: string, value: Record<string, unknown>): Promise<void> {
  await controlDb
    .insert(platformSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
  revalidateTag("platform-settings");
}

export async function deleteSetting(key: string): Promise<void> {
  await controlDb.delete(platformSettings).where(eq(platformSettings.key, key));
  revalidateTag("platform-settings");
}
