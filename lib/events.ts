import { and, eq } from "drizzle-orm";
import type { Collection, EventAction } from "@/db/schema";
import { deliverWebhook } from "./webhook";
import { connectorSecret, getConnector } from "./connectors";
import { matchesClauses } from "./query";
import { ValidationError } from "./validation";
import { db } from "@/db";
import { webhookDeliveries } from "@/db/schema";

/**
 * The single emit point (Phase 3). Every entry mutation — MCP, admin, or
 * delivery API — flows through the entries layer, which calls emitEntryEvent.
 * Actions are declarative per collection: webhook (retry+log via lib/webhook)
 * or email (via the project's Resend connector; validated at define time).
 * Subsystem 08: actions may carry `when` clauses (evaluated against the entry
 * snapshot) and `disabled`; updated events include the previous snapshot +
 * changedFields; failed deliveries can be re-fired from the log.
 * The legacy publicWrite webhookUrl still fires as an implicit created-webhook.
 */

export type EntryEvent = "created" | "updated" | "deleted";

export async function emitEntryEvent(
  collection: Collection,
  event: EntryEvent,
  entry: { id: string; data?: Record<string, unknown> },
  previous?: Record<string, unknown>,
): Promise<void> {
  const declared: EventAction[] = [...(collection.events?.[event] ?? [])];
  if (event === "created" && collection.webhookUrl) {
    declared.push({ type: "webhook", url: collection.webhookUrl });
  }
  const actions = declared.filter((a) => {
    if (a.disabled) return false;
    if (!a.when || a.when.length === 0) return true;
    // `when` evaluates against the entry AS IT NOW IS (post-change snapshot).
    return entry.data ? matchesClauses(collection.fields, a.when, entry.data) : false;
  });
  if (actions.length === 0) return;

  const changedFields =
    previous && entry.data
      ? Object.keys({ ...previous, ...entry.data }).filter(
          (k) => JSON.stringify(previous[k]) !== JSON.stringify(entry.data![k]),
        )
      : undefined;
  const payload: Record<string, unknown> = {
    collection: collection.name,
    entry,
    ...(previous ? { previous: { data: previous }, changedFields } : {}),
  };

  await Promise.allSettled(
    actions.map((a) =>
      a.type === "webhook"
        ? deliverWebhook({
            projectId: collection.projectId,
            collectionId: collection.id,
            url: a.url,
            event: `entry.${event}`,
            payload,
          })
        : sendEmailAction(collection, `entry.${event}`, a, entry, payload),
    ),
  );
}

/** {{field}} placeholders resolve from entry data; {{id}} from the entry id. */
function interpolate(template: string, entry: { id: string; data?: Record<string, unknown> }): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    key === "id" ? entry.id : String(entry.data?.[key] ?? ""),
  );
}

async function sendEmailAction(
  collection: Collection,
  event: string,
  action: Extract<EventAction, { type: "email" }>,
  entry: { id: string; data?: Record<string, unknown> },
  basePayload: Record<string, unknown>,
): Promise<void> {
  const rendered = {
    to: interpolate(action.to, entry),
    subject: interpolate(action.subject, entry),
    text: `${event} in "${collection.displayName}"\n\n${JSON.stringify(entry.data ?? { id: entry.id }, null, 2)}`,
  };
  // The rendered email is stored with the log row so a failed send can be
  // re-fired verbatim later, without re-deriving templates.
  await dispatchEmail(collection.projectId, collection.id, event, rendered, {
    ...basePayload,
    email: rendered,
  });
}

export interface RenderedEmail {
  to: string;
  subject: string;
  text: string;
}

/** Send one rendered email via the project's Resend connector; log the outcome. */
async function dispatchEmail(
  projectId: string,
  collectionId: string,
  event: string,
  rendered: RenderedEmail,
  logPayload: Record<string, unknown>,
): Promise<"success" | "failed"> {
  let status: "success" | "failed" = "failed";
  let lastError: string | null = null;
  try {
    const [key, connector] = await Promise.all([
      connectorSecret(projectId, "resend"),
      getConnector(projectId, "resend"),
    ]);
    if (!key || !connector) throw new Error("resend connector not configured");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: connector.config.fromEmail,
        to: [rendered.to],
        subject: rendered.subject,
        text: rendered.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) status = "success";
    else lastError = `Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
  try {
    await db.insert(webhookDeliveries).values({
      projectId,
      collectionId,
      url: `email:${rendered.to}`,
      event,
      payload: logPayload,
      status,
      attempts: "1",
      lastError,
    });
  } catch {
    // Logging must never take down the mutation path.
  }
  return status;
}

/**
 * Replay a logged delivery: webhooks re-post the stored payload (fresh retry
 * cycle), emails re-send the stored render. Either way the outcome lands in
 * the log as a NEW row — the original stays as history.
 */
export async function refireDelivery(
  projectId: string,
  deliveryId: string,
): Promise<"success" | "failed"> {
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.projectId, projectId)))
    .limit(1);
  if (!row) throw new ValidationError(`delivery ${deliveryId} not found`, "E_NOT_FOUND");

  if (row.url.startsWith("email:")) {
    const rendered = (row.payload as { email?: Partial<RenderedEmail> }).email;
    if (!rendered?.to || !rendered.subject) {
      throw new ValidationError(
        "this email delivery predates stored renders — re-trigger it by updating the entry instead",
      );
    }
    return dispatchEmail(
      projectId,
      row.collectionId,
      row.event,
      { to: rendered.to, subject: rendered.subject, text: rendered.text ?? "" },
      row.payload,
    );
  }
  return deliverWebhook({
    projectId,
    collectionId: row.collectionId,
    url: row.url,
    event: row.event,
    payload: row.payload,
  });
}
