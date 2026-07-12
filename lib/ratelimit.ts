import { sql } from "drizzle-orm";
import { controlDb } from "@/db";

/**
 * Durable rate limiter (C2). Fixed one-minute windows in the control DB,
 * counted by a single atomic UPSERT per limited request — shared across
 * instances and restarts (the launch requirement the old in-memory store
 * couldn't meet; its interface anticipated this swap). Fixed windows admit
 * ≤2× bursts at a boundary vs the old sliding window — acceptable for an
 * abuse brake, and never stricter, so no existing traffic gets newly blocked.
 *
 * FAIL-OPEN by design: this gate protects capacity, not authorization. If the
 * control DB errors, the request proceeds (and will meet the same DB at
 * content time anyway) rather than turning a blip into a 429 storm.
 *
 * The same rows double as request metering (B3's deferral): pass `projectId`
 * to attribute the hit; rollupUsage() folds expired windows into usage_daily.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

export async function rateLimit(
  key: string,
  opts: { projectId?: string; max?: number } = {},
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const max = opts.max ?? MAX_PER_WINDOW;
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
  try {
    const result = await controlDb.execute(sql`
      INSERT INTO rate_windows (key, window_start, project_id, count)
      VALUES (${key}, ${windowStart.toISOString()}, ${opts.projectId ?? null}, 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_windows.count + 1
      RETURNING count`);
    const rows = ((result as unknown as { rows?: { count: number }[] }).rows ??
      (result as unknown as { count: number }[])) as { count: number }[];
    const count = Number(rows[0]?.count ?? 1);
    if (count <= max) return { allowed: true, retryAfterSec: 0 };
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((windowStart.getTime() + WINDOW_MS - now) / 1000)),
    };
  } catch (e) {
    console.error("rate-limit store unavailable — failing open", e instanceof Error ? e.message : e);
    return { allowed: true, retryAfterSec: 0 };
  }
}

/**
 * Fold expired windows into per-project daily usage and drop them — one
 * atomic statement (CTE), safe under concurrent drains: a row is deleted and
 * aggregated exactly once. Unattributed windows (no projectId) just expire.
 * Runs from the drain route; a couple of minutes of lag is fine for a
 * console metric.
 */
export async function rollupUsage(): Promise<number> {
  const cutoff = new Date(Date.now() - 2 * WINDOW_MS).toISOString();
  const result = await controlDb.execute(sql`
    WITH expired AS (
      DELETE FROM rate_windows WHERE window_start < ${cutoff}
      RETURNING project_id, window_start, count
    )
    INSERT INTO usage_daily (project_id, day, count)
    SELECT project_id, (window_start AT TIME ZONE 'UTC')::date, SUM(count)::int
    FROM expired
    WHERE project_id IS NOT NULL
    GROUP BY 1, 2
    ON CONFLICT (project_id, day) DO UPDATE SET count = usage_daily.count + EXCLUDED.count
    RETURNING count`);
  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return rows.length;
}
