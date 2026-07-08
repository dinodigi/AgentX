import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { bearerFrom } from "@/lib/tokens";
import { drainJobs, reclaimStale } from "@/lib/jobs";
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
  const result = await drainJobs(HANDLERS, { maxJobs: 10, budgetMs: 15_000 });
  return json(200, { ...result, reclaimed });
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
