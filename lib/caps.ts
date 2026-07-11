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

function capError(what: string, limit: number | string): never {
  throw new ValidationError(
    `sandbox cap reached: ${what} (limit ${limit}) — free sandboxes are for trying things out; delete some, or upgrade this project to a paid plan for real capacity`,
    "E_CAP_REACHED",
  );
}

/** Gate adding `add` entries to a sandbox project (create/bulk/transact). */
export async function assertEntryCap(projectId: string, add = 1): Promise<void> {
  if ((await projectPlan(projectId)) !== "sandbox") return;
  const tdb = await tenantDb(projectId);
  const [row] = await tdb.select({ n: count() }).from(entries).where(eq(entries.projectId, projectId));
  if ((row?.n ?? 0) + add > SANDBOX_CAPS.entries) capError("entries", SANDBOX_CAPS.entries);
}

/** Gate creating a NEW collection on a sandbox project. */
export async function assertCollectionCap(projectId: string): Promise<void> {
  if ((await projectPlan(projectId)) !== "sandbox") return;
  const [row] = await controlDb
    .select({ n: count() })
    .from(collections)
    .where(eq(collections.projectId, projectId));
  if ((row?.n ?? 0) + 1 > SANDBOX_CAPS.collections) capError("collections", SANDBOX_CAPS.collections);
}

/** Gate uploading `addBytes` of media to a sandbox project. */
export async function assertAssetCap(projectId: string, addBytes: number): Promise<void> {
  if ((await projectPlan(projectId)) !== "sandbox") return;
  const tdb = await tenantDb(projectId);
  const [row] = await tdb
    .select({ total: sql<string>`coalesce(sum(${assets.size}::bigint), 0)` })
    .from(assets)
    .where(eq(assets.projectId, projectId));
  if (Number(row?.total ?? 0) + addBytes > SANDBOX_CAPS.assetBytes) {
    capError("media storage", `${SANDBOX_CAPS.assetBytes / 1024 / 1024} MB`);
  }
}

/**
 * Sandboxes live on the SHARED planes by definition — attaching a dedicated
 * database or bucket is what the paid plans are. Connect/provision flows call
 * this first.
 */
export async function assertConnectorAllowed(projectId: string): Promise<void> {
  if ((await projectPlan(projectId)) === "sandbox") {
    throw new ValidationError(
      "sandbox projects run on the shared infrastructure — upgrade this project to a paid plan to attach its own database or bucket",
      "E_CAP_REACHED",
    );
  }
}
