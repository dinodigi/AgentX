import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { bearerFrom } from "@/lib/tokens";
import { drainJobs, reclaimStale } from "@/lib/jobs";
import { tickSchedules } from "@/lib/schedules";
import { rollupUsage } from "@/lib/ratelimit";
import { snapshotNeonUsage } from "@/lib/neon-usage";
import { reportMeteredUsage } from "@/lib/metered-billing";
import { HANDLERS } from "@/lib/job-handlers";

/**
 * Host-agnostic cron surface. Any scheduler POSTs here with the CRON_SECRET as a
 * bearer token: Netlify scheduled function today, Render cron curl tomorrow.
 *
 * This route is EXCLUDED from Clerk middleware, so the secret compare is the ONLY
 * gate on an endpoint that executes cross-project side effects. It is therefore
 * FAIL-CLOSED:
 *   1. a missing or <16-char CRON_SECRET returns 503 E_UNCONFIGURED BEFORE the
 *      Authorization header is read — an unset env can never degrade to accepting
 *      the literal "Bearer undefined";
 *   2. the compare is constant-time over equal-length buffers (length mismatch is
 *      an immediate reject), never a template like `Bearer ${env}`.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    return json(503, {
      error: "job drain not configured — set CRON_SECRET (min 16 chars) in the server env",
      code: "E_UNCONFIGURED",
    });
  }

  const provided = bearerFrom(req.headers.get("authorization"));
  if (provided === null || !constantTimeEqual(provided, secret)) {
    return json(401, { error: "invalid or missing CRON_SECRET bearer token", code: "E_AUTH" });
  }

  const reclaimed = await reclaimStale();
  // Tick BEFORE draining so a due schedule's fire runs in this same pass.
  const ticked = await tickSchedules();
  const result = await drainJobs(HANDLERS, { maxJobs: 10, budgetMs: 15_000 });
  // C2: fold expired rate windows into usage_daily. Never fails the drain —
  // the next pass sweeps whatever this one missed.
  let rolledUp = 0;
  try {
    rolledUp = await rollupUsage();
  } catch (e) {
    console.error("usage rollup failed (will retry next drain)", e instanceof Error ? e.message : e);
  }
  // Track 4b: Neon consumption sweep (managed planes; self-throttled ~6h).
  // Same contract as the rollup — never fails the drain.
  let neonUsage = 0;
  try {
    neonUsage = await snapshotNeonUsage();
  } catch (e) {
    console.error("neon usage snapshot failed (will retry next drain)", e instanceof Error ? e.message : e);
  }
  // Track 4d: month-to-date metered usage → Stripe, riding the sweep cadence
  // (fresh snapshot → report; action=set is idempotent). Inert until the
  // operator sets METERED_RATES.
  let metered = 0;
  if (neonUsage > 0) {
    try {
      metered = await reportMeteredUsage();
    } catch (e) {
      console.error("metered usage report failed (will retry next sweep)", e instanceof Error ? e.message : e);
    }
  }
  return json(200, { ...result, reclaimed, ticked, rolledUp, neonUsage, metered });
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(ab, bb);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
