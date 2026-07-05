import type { Collection, EventAction } from "@/db/schema";
import { deliverWebhook } from "./webhook";
import { connectorSecret, getConnector } from "./connectors";
import { db } from "@/db";
import { webhookDeliveries } from "@/db/schema";

/**
 * The single emit point (Phase 3). Every entry mutation — MCP, admin, or
 * delivery API — flows through the entries layer, which calls emitEntryEvent.
 * Actions are declarative per collection: webhook (retry+log via lib/webhook)
 * or email (via the project's Resend connector; validated at define time).
 * The legacy publicWrite webhookUrl still fires as an implicit created-webhook.
 */

export type EntryEvent = "created" | "updated" | "deleted";

export async function emitEntryEvent(
  collection: Collection,
  event: EntryEvent,
  entry: { id: string; data?: Record<string, unknown> },
): Promise<void> {
  const actions: EventAction[] = [...(collection.events?.[event] ?? [])];
  if (event === "created" && collection.webhookUrl) {
    actions.push({ type: "webhook", url: collection.webhookUrl });
  }
  if (actions.length === 0) return;

  const payload = { collection: collection.name, entry };
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
        : sendEmailAction(collection, `entry.${event}`, a, entry),
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
): Promise<void> {
  const to = interpolate(action.to, entry);
  let status: "success" | "failed" = "failed";
  let lastError: string | null = null;
  try {
    const [key, connector] = await Promise.all([
      connectorSecret(collection.projectId, "resend"),
      getConnector(collection.projectId, "resend"),
    ]);
    if (!key || !connector) throw new Error("resend connector not configured");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: connector.config.fromEmail,
        to: [to],
        subject: interpolate(action.subject, entry),
        text: `${event} in "${collection.displayName}"\n\n${JSON.stringify(entry.data ?? { id: entry.id }, null, 2)}`,
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
      projectId: collection.projectId,
      collectionId: collection.id,
      url: `email:${to}`,
      event,
      payload: { collection: collection.name, entry },
      status,
      attempts: "1",
      lastError,
    });
  } catch {
    // Logging must never take down the mutation path.
  }
}
