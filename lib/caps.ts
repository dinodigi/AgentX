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
 * `plan` NULL (legacy/operator projects) stays uncapped; sandbox and paid
 * plans are capped per the tables below.
 *
 * Under the usage-metering decision (2026-07-17, POST-DEPLOYMENT-V1.0-PLAN
 * Track 4) these caps are the SAFETY FLOOR, not the biller: the meter bills
 * actual Neon/R2 usage; caps bound the blast radius of a runaway agent.
 */
export const SANDBOX_CAPS = {
  entries: 1_000,
  collections: 20,
  assetBytes: 100 * 1024 * 1024, // 100 MB
  // Total stored JSONB (post-TOAST, what Neon storage actually costs). The
  // entries cap bounds row COUNT; this bounds row FAT — 1k entries × 1 MiB
  // bodies would otherwise be a 1 GB free sandbox.
  dataBytes: 50 * 1024 * 1024, // 50 MB — OPERATOR REVIEW: tune with pricing
} as const;

/**
 * Paid plans get generous ABUSE CEILINGS, not product tiers — high enough that
 * a real site never sees them; low enough that a runaway agent or abuser can't
 * turn a flat month into unbounded storage. Request metering rides the C2
 * durable store; Neon/R2 usage metering (Track 4b) bills the real usage.
 */
export const PAID_CAPS = {
  entries: 250_000,
  collections: 500,
  assetBytes: 25 * 1024 * 1024 * 1024, // 25 GB
  dataBytes: 5 * 1024 * 1024 * 1024, // 5 GB — OPERATOR REVIEW: tune with pricing
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

/**
 * Gate TOTAL stored entry bytes (create/bulk/transact/update). Update matters
 * most: row count never moves, so without this an at-cap project could inflate
 * every entry toward the body limit unbounded (250k × 1 MiB = 244 GB).
 *
 * The sum is a per-project scan (pg_column_size = post-TOAST, i.e. what Neon
 * storage costs), so it's CACHED ~60s — a ceiling, not a meter: overshoot is
 * bounded by one rate-limited minute of writes, and exact usage is Track 4b's
 * job. Reads the project's own tenant DB, like the entry/asset caps.
 */
export async function assertDataBytes(projectId: string): Promise<void> {
  const c = capsFor(await projectPlan(projectId));
  if (!c) return;
  const cached = unstable_cache(
    async () => {
      const tdb = await tenantDb(projectId);
      const [row] = await tdb
        .select({ total: sql<string>`coalesce(sum(pg_column_size(${entries.data})), 0)` })
        .from(entries)
        .where(eq(entries.projectId, projectId));
      return Number(row?.total ?? 0);
    },
    ["project-data-bytes", projectId],
    { revalidate: 60, tags: [`project:${projectId}`] },
  );
  if ((await cached()) >= c.caps.dataBytes) {
    capError(c.tier, "stored content", `${Math.round(c.caps.dataBytes / 1024 / 1024)} MB`);
  }
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
