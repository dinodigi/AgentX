import "server-only";
import { count, eq, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { controlDb } from "@/db";
import { assets, collections, entries, projects } from "@/db/schema";
import { tenantDb } from "./data-plane";
import { ValidationError } from "./validation";

/**
 * Plan caps (B2): the free sandbox is the abuse gate — hard limits with
 * agent-repairable errors (E_CAP_REACHED names the cap and the way out).
 * Values here are the B2 placeholders; B3 finalizes them alongside the paid
 * plans' allowances. `plan` NULL (legacy/operator projects) and paid plans
 * are uncapped until B3.
 */
export const SANDBOX_CAPS = {
  entries: 1_000,
  collections: 20,
  assetBytes: 100 * 1024 * 1024, // 100 MB
} as const;

/**
 * B3: paid plans get generous ABUSE CEILINGS, not product tiers — flat price +
 * included allowances per the caps-not-metering decision. High enough that a
 * real site never sees them; low enough that a runaway agent or abuser can't
 * turn $19 into unbounded storage. Request metering rides the C2 durable
 * store, not these stored-dimension checks.
 */
export const PAID_CAPS = {
  entries: 250_000,
  collections: 500,
  assetBytes: 25 * 1024 * 1024 * 1024, // 25 GB
} as const;

function capsFor(plan: "sandbox" | "byo" | "managed" | null) {
  if (plan === "sandbox") return { caps: SANDBOX_CAPS, tier: "sandbox" as const };
  if (plan === "byo" || plan === "managed") return { caps: PAID_CAPS, tier: "plan" as const };
  return null; // legacy/operator-era — uncapped
}

/** Cached plan lookup — shares the project:{id} tag with the other config. */
export async function projectPlan(projectId: string): Promise<"sandbox" | "byo" | "managed" | null> {
  const cached = unstable_cache(
    async () => {
      const rows = await controlDb
        .select({ plan: projects.plan })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      return rows[0]?.plan ?? null;
    },
    ["project-plan", projectId],
    { tags: [`project:${projectId}`] },
  );
  return cached();
}

function capError(tier: "sandbox" | "plan", what: string, limit: number | string): never {
  throw new ValidationError(
    tier === "sandbox"
      ? `sandbox cap reached: ${what} (limit ${limit}) — free sandboxes are for trying things out; delete some, or upgrade this project to a paid plan for real capacity`
      : `plan cap reached: ${what} (limit ${limit}) — this is the plan's abuse ceiling; delete some, or contact us to raise it`,
    "E_CAP_REACHED",
  );
}

/** Gate adding `add` entries (create/bulk/transact). */
export async function assertEntryCap(projectId: string, add = 1): Promise<void> {
  const c = capsFor(await projectPlan(projectId));
  if (!c) return;
  const tdb = await tenantDb(projectId);
  const [row] = await tdb.select({ n: count() }).from(entries).where(eq(entries.projectId, projectId));
  if ((row?.n ?? 0) + add > c.caps.entries) capError(c.tier, "entries", c.caps.entries);
}

/** Gate creating a NEW collection. */
export async function assertCollectionCap(projectId: string): Promise<void> {
  const c = capsFor(await projectPlan(projectId));
  if (!c) return;
  const [row] = await controlDb
    .select({ n: count() })
    .from(collections)
    .where(eq(collections.projectId, projectId));
  if ((row?.n ?? 0) + 1 > c.caps.collections) capError(c.tier, "collections", c.caps.collections);
}

/** Gate uploading `addBytes` of media. */
export async function assertAssetCap(projectId: string, addBytes: number): Promise<void> {
  const c = capsFor(await projectPlan(projectId));
  if (!c) return;
  const tdb = await tenantDb(projectId);
  const [row] = await tdb
    .select({ total: sql<string>`coalesce(sum(${assets.size}::bigint), 0)` })
    .from(assets)
    .where(eq(assets.projectId, projectId));
  if (Number(row?.total ?? 0) + addBytes > c.caps.assetBytes) {
    capError(c.tier, "media storage", `${c.caps.assetBytes / 1024 / 1024} MB`);
  }
}

/**
 * Sandboxes live on the SHARED planes by definition — attaching a dedicated
 * database or bucket is what the paid plans are. Connect/provision flows call
 * this first and surface the message as their {ok:false} result — RETURNED,
 * not thrown, because a thrown refusal inside a server action becomes an
 * opaque 500 digest in production (found live 2026-07-12).
 */
export async function connectorRefusal(projectId: string): Promise<string | null> {
  if ((await projectPlan(projectId)) === "sandbox") {
    return "sandbox projects run on the shared infrastructure — upgrade this project to a paid plan to attach its own database or bucket";
  }
  return null;
}
