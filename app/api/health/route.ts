import { sql } from "drizzle-orm";
import { controlDb } from "@/db";

/**
 * Health check (C5) — LIVENESS, reported 200; readiness is in the BODY.
 *
 * This split is OPS-3, and it is written in blood: on 2026-07-21 the control
 * DB's compute quota ran out, this endpoint answered 503, Render pulled every
 * instance and restart-looped the service, and *every* route 502'd — including
 * static marketing pages that need no database at all. A dependency outage
 * became a total blackout because the liveness probe was reporting readiness.
 *
 * So: the process answering AT ALL is liveness, and that is what Render is
 * asked to judge. A control-DB failure returns **200 with
 * {status:"degraded",db:"down"}** — the instance stays in rotation, static
 * pages keep serving, the jobs-drain cron stays reachable, and DB-backed APIs
 * fail honestly per-request instead of being replaced by a restart loop.
 * A genuinely hung process still restarts: no response at all trips Render's
 * own timeout, which is the failure mode a health check should catch.
 *
 * Monitoring is UNAFFECTED: UptimeRobot matches the keyword "ok", which the
 * degraded body does not contain, so a DB outage still pages.
 *
 * TRADEOFF, on purpose: a fresh deploy with a wrong/missing DATABASE_URL now
 * PASSES this gate and rolls out serving degraded, where before it would have
 * been held back. Availability over gatekeeping — see runbooks/STATUS-PAGE-SETUP.md.
 *
 * Public + uncached by design (no secrets in the body). `?deep` additionally
 * counts a table so a connected-but-empty pool still proves it can query.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") !== null;
  const started = Date.now();
  try {
    await controlDb.execute(deep ? sql`SELECT count(*) FROM projects` : sql`SELECT 1`);
    return Response.json(
      { status: "ok", db: "up", deep, latencyMs: Date.now() - started },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    // Log the detail server-side; the body stays generic (public endpoint).
    console.error("health check: control DB unreachable", e instanceof Error ? e.message : e);
    // 200 ON PURPOSE — see the header. Readiness is the body's job; returning
    // non-200 here is what turned a DB outage into a full-site blackout.
    return Response.json(
      { status: "degraded", db: "down", deep, latencyMs: Date.now() - started },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
