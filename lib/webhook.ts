import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, webhookDeliveries } from "@/db/schema";

/**
 * Webhook delivery with retries + an outcome log. A public-form submission
 * whose notification silently vanishes is the worst failure mode this system
 * has, so every delivery attempt ends in a webhook_deliveries row either way.
 * Still no email engine — the webhook is the boundary.
 */

const BACKOFF_MS = [0, 1000, 3000];
const TIMEOUT_MS = 10_000;

export async function deliverWebhook(opts: {
  projectId: string;
  collectionId: string;
  url: string;
  event: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const body = JSON.stringify({ event: opts.event, ...opts.payload });
  let lastError = "";

  // Stripe-style signature so receivers can verify authenticity + freshness:
  //   X-AgentX-Signature: t=<unix>,v1=HMAC_SHA256(secret, `${t}.${body}`)
  const [project] = await db
    .select({ secret: projects.webhookSigningSecret })
    .from(projects)
    .where(eq(projects.id, opts.projectId))
    .limit(1);

  for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
    const wait = BACKOFF_MS[attempt - 1];
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (project?.secret) {
        const t = Math.floor(Date.now() / 1000);
        const v1 = createHmac("sha256", project.secret).update(`${t}.${body}`).digest("hex");
        headers["x-agentx-signature"] = `t=${t},v1=${v1}`;
      }
      const res = await fetch(opts.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        await log(opts, "success", attempt, null);
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  await log(opts, "failed", BACKOFF_MS.length, lastError);
}

async function log(
  opts: { projectId: string; collectionId: string; url: string; event: string; payload: Record<string, unknown> },
  status: "success" | "failed",
  attempts: number,
  lastError: string | null,
): Promise<void> {
  try {
    await db.insert(webhookDeliveries).values({
      projectId: opts.projectId,
      collectionId: opts.collectionId,
      url: opts.url,
      event: opts.event,
      payload: opts.payload,
      status,
      attempts: String(attempts),
      lastError,
    });
  } catch {
    // Logging must never take down the request path.
  }
}
