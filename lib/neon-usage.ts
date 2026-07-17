import "server-only";
import { eq, sql } from "drizzle-orm";
import { controlDb } from "@/db";
import { neonUsageDaily, projectConnectors } from "@/db/schema";
import { getNeonProjectConsumption } from "./neon-api";

/**
 * Track 4b: snapshot per-project Neon consumption into neon_usage_daily.
 *
 * Scope: MANAGED data planes only — a `neon` connector with mode:"managed"
 * (a Neon project in OUR org that WE pay for). BYO databases are the
 * customer's cost and are never snapshotted.
 *
 * The Neon project object reports current-billing-period TOTALS, so one row
 * per (project, day) keeps the latest snapshot; the read layer (4c) diffs
 * day-over-day for daily usage and uses consumption_period_start to detect
 * period resets. Runs on the every-minute drain cron but self-throttles to a
 * fleet sweep every ~6h — usage billing needs daily grain, not minutes.
 */
const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function snapshotNeonUsage(): Promise<number> {
  if (!process.env.NEON_API_KEY) return 0; // BYO-only install — nothing we pay for

  // Global throttle: the newest capture anywhere gates the sweep. Cheap (PK'd
  // small table) and instance-agnostic — any app instance may run the drain.
  const [latest] = await controlDb
    .select({ at: sql<string | null>`max(${neonUsageDaily.capturedAt})` })
    .from(neonUsageDaily);
  if (latest?.at && Date.now() - new Date(latest.at).getTime() < SNAPSHOT_INTERVAL_MS) return 0;

  const rows = await controlDb
    .select({ projectId: projectConnectors.projectId, config: projectConnectors.config })
    .from(projectConnectors)
    .where(eq(projectConnectors.type, "neon"));
  const managed = rows.flatMap((r) => {
    const cfg = r.config as { mode?: string; neonProjectId?: string } | null;
    return cfg?.mode === "managed" && cfg.neonProjectId
      ? [{ projectId: r.projectId, neonProjectId: cfg.neonProjectId }]
      : [];
  });
  if (managed.length === 0) return 0;

  const day = new Date().toISOString().slice(0, 10); // UTC, same grain as usage_daily
  let captured = 0;
  for (const m of managed) {
    try {
      const c = await getNeonProjectConsumption(m.neonProjectId);
      const values = {
        computeTimeSeconds: c.computeTimeSeconds,
        activeTimeSeconds: c.activeTimeSeconds,
        writtenDataBytes: c.writtenDataBytes,
        dataStorageBytesHour: c.dataStorageBytesHour,
        syntheticStorageSizeBytes: c.syntheticStorageSizeBytes,
        dataTransferBytes: c.dataTransferBytes,
        consumptionPeriodStart: c.consumptionPeriodStart ? new Date(c.consumptionPeriodStart) : null,
        capturedAt: new Date(),
      };
      await controlDb
        .insert(neonUsageDaily)
        .values({ projectId: m.projectId, day, ...values })
        .onConflictDoUpdate({ target: [neonUsageDaily.projectId, neonUsageDaily.day], set: values });
      captured++;
    } catch (e) {
      // One unreachable tenant (deleted Neon project, API blip) must not stop
      // the fleet sweep — log and keep going; the next sweep retries.
      console.error(
        `neon usage snapshot failed for project ${m.projectId}`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return captured;
}
