import { sql } from "drizzle-orm";
import { controlDb } from "@/db";

/**
 * Health check (C5). Liveness is the process answering at all; readiness is
 * the control DB reachable — the one dependency without which every surface
 * fails. Render's healthCheckPath hits this; a non-200 pulls the instance out
 * of rotation / triggers a restart instead of serving 500s. Public + uncached
 * by design (no secrets in the body). `?deep` additionally counts a table so
 * a connected-but-empty pool still proves it can query.
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
    return Response.json(
      { status: "degraded", db: "down", latencyMs: Date.now() - started },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
