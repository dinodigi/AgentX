import { createHmac } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { tenantDb } from "./data-plane";
import { webhookTargetRefusal } from "./net-guard";
import { projects, webhookDeliveries, type WebhookDelivery } from "@/db/schema";

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
  /** null for project-level events (schedule.fired) — no collection to pin. */
  collectionId: string | null;
  url: string;
  event: string;
  payload: Record<string, unknown>;
}): Promise<"success" | "failed"> {
  const body = JSON.stringify({ event: opts.event, ...opts.payload });
  let lastError = "";

  // C4 SSRF guard: refuse private/loopback/link-local targets BEFORE any
  // attempt — the delivery log echoes status codes, so an unguarded fetch is
  // a blind port scanner into our network. The refusal lands in the log like
  // any failure (visible, diagnosable), and no retry can bypass it.
  const refusal = await webhookTargetRefusal(opts.url);
  if (refusal) {
    await log(opts, "failed", 0, refusal);
    return "failed";
  }

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
        return "success";
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  await log(opts, "failed", BACKOFF_MS.length, lastError);
  return "failed";
}

export interface DeliveryFilter {
  collectionId?: string;
  status?: "success" | "failed";
  event?: string;
  limit: number;
  offset: number;
}

/** Newest-first page of the delivery log (webhooks + emails), limit+1 probe row included. */
export async function listDeliveries(
  projectId: string,
  f: DeliveryFilter,
): Promise<WebhookDelivery[]> {
  const conditions = [eq(webhookDeliveries.projectId, projectId)];
  if (f.collectionId) conditions.push(eq(webhookDeliveries.collectionId, f.collectionId));
  if (f.status) conditions.push(eq(webhookDeliveries.status, f.status));
  if (f.event) conditions.push(eq(webhookDeliveries.event, f.event));
  return (await tenantDb(projectId))
    .select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(f.limit + 1)
    .offset(f.offset);
}

/**
 * Log an INBOUND event outcome (K4 Stripe webhooks). The url is a
 * `stripe:<eventType>` pseudo-target, never a real endpoint — refireDelivery
 * refuses to re-POST it (openMinor #7). Logging is best-effort; a real DB
 * failure on the order flip is surfaced separately so Stripe retries.
 */
export async function recordInboundDelivery(opts: {
  projectId: string;
  collectionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "success" | "failed";
  note?: string | null;
}): Promise<void> {
  await log(
    {
      projectId: opts.projectId,
      collectionId: opts.collectionId,
      url: `stripe:${opts.eventType}`,
      event: `stripe.${opts.eventType}`,
      payload: opts.payload,
    },
    opts.status,
    1,
    opts.note ?? null,
  );
}

async function log(
  opts: { projectId: string; collectionId: string | null; url: string; event: string; payload: Record<string, unknown> },
  status: "success" | "failed",
  attempts: number,
  lastError: string | null,
): Promise<void> {
  try {
    await (await tenantDb(opts.projectId)).insert(webhookDeliveries).values({
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
