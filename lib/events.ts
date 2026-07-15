import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Collection, EventAction } from "@/db/schema";
import { deliverWebhook } from "./webhook";
import { connectorSecret, getConnector } from "./connectors";
import { matchesClauses } from "./query";
import { ValidationError } from "./validation";
import { enqueueJob } from "./jobs";
import { tenantDb } from "./data-plane";
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

/** `after` grammar: "45m" | "12h" | "3d", bounded 1 minute .. 365 days. */
const AFTER_RE = /^(\d+)(m|h|d)$/;
const AFTER_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const AFTER_MAX_MS = 365 * AFTER_UNIT_MS.d;

/** Parse an `after` duration to ms, or null when malformed / out of bounds. */
export function parseAfter(after: string): number | null {
  const m = AFTER_RE.exec(after);
  if (!m) return null;
  const ms = Number(m[1]) * AFTER_UNIT_MS[m[2] as keyof typeof AFTER_UNIT_MS];
  return ms >= AFTER_UNIT_MS.m && ms <= AFTER_MAX_MS ? ms : null;
}

/**
 * Stable identity of an action's CONTENT: sha256 over canonical JSON (sorted
 * keys), excluding only `disabled`. Queued delayed jobs carry this hash and are
 * matched against the CURRENT config at run time — so editing url/to/subject/
 * when/after orphans (skips) jobs queued under the old definition, while
 * toggling `disabled` keeps matching (disabled:true = paused, not re-identified).
 */
export function actionHash(action: EventAction): string {
  const { disabled: _disabled, ...content } = action;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function emitEntryEvent(
  collection: Collection,
  event: EntryEvent,
  entry: { id: string; data?: Record<string, unknown> },
  previous?: Record<string, unknown>,
  /** Extra top-level payload fields — e.g. {restored:true, deletedAt} on a restore. */
  extra?: Record<string, unknown>,
): Promise<void> {
  const declared: EventAction[] = [...(collection.events?.[event] ?? [])];
  if (event === "created" && collection.webhookUrl) {
    declared.push({ type: "webhook", url: collection.webhookUrl });
  }
  const actions = declared.filter((a) => {
    if (a.disabled) return false;
    if (!a.when || a.when.length === 0) return true;
    if (!entry.data || !matchesClauses(collection.fields, a.when, entry.data)) return false;
    // On an UPDATE, a conditional action fires when the condition BECOMES true —
    // a field the `when` watches actually changed on this write — not on every
    // later re-save that still happens to match. Without this an order already
    // at status=paid would re-fire its fulfillment on any unrelated edit (K4
    // duplicate-shipment bug). `created`/restores have no previous ⇒ always fire.
    if (previous) {
      const watched = new Set<string>();
      for (const c of a.when) {
        if ("anyOf" in c) c.anyOf.forEach((sub) => watched.add(sub.field));
        else watched.add(c.field);
      }
      const changed = [...watched].some(
        (name) => JSON.stringify(previous[name]) !== JSON.stringify(entry.data![name]),
      );
      if (!changed) return false;
    }
    return true;
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
    ...(extra ?? {}),
  };

  // Partition: `after` actions are enqueued as jobs (G2); the rest fire now.
  // The dedupeKey pins timing to the FIRST matching event — later updates
  // neither reset the timer nor enqueue a second send while one is queued.
  const immediate = actions.filter((a) => !a.after);
  const delayed = actions.filter((a) => a.after);

  await Promise.allSettled([
    ...immediate.map((a) => runEventAction(collection, `entry.${event}`, a, entry, payload)),
    ...delayed.map((a) => {
      const ms = parseAfter(a.after!);
      if (ms === null) return Promise.resolve(); // define-time validation bars this
      const hash = actionHash(a);
      return enqueueJob({
        projectId: collection.projectId,
        kind: "event_action",
        runAt: new Date(Date.now() + ms),
        dedupeKey: `${entry.id}:${event}:${hash}`,
        payload: {
          collectionId: collection.id,
          collectionName: collection.name,
          event,
          entryId: entry.id,
          actionHash: hash,
          // Display/debug ONLY — the handler re-resolves the action from the
          // CURRENT collection config and never executes this copy.
          enqueuedAction: a,
          ...(changedFields ? { changedFields } : {}),
        },
      });
    }),
  ]);
}

/**
 * Dispatch ONE action (webhook or email) with a ready payload — the shared exit
 * point for immediate events, delayed jobs (G2), and later schedule/transition
 * actions. Every outcome lands in webhook_deliveries.
 */
export async function runEventAction(
  collection: Collection,
  event: string,
  action: EventAction,
  entry: { id: string; data?: Record<string, unknown> },
  payload: Record<string, unknown>,
): Promise<void> {
  if (action.type === "webhook") {
    await deliverWebhook({
      projectId: collection.projectId,
      collectionId: collection.id,
      url: action.url,
      event,
      payload,
    });
  } else {
    await sendEmailAction(collection, event, action, entry, payload);
  }
}

/**
 * A single, well-formed recipient. Blocks header/CRLF injection, multi-recipient
 * fan-out (commas/semicolons) and empty renders. Defense-in-depth for the F2
 * email-relay vector: `to` is interpolated from entry data, so once F2 is fixed
 * the submitter can't control it — but a malformed template still shouldn't
 * reach Resend from the project's verified domain.
 */
function isValidEmailRecipient(addr: string): boolean {
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(addr);
}

/** {{field}} placeholders resolve from entry data; {{id}} from the entry id. */
function interpolate(template: string, entry: { id: string; data?: Record<string, unknown> }): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    key === "id" ? entry.id : String(entry.data?.[key] ?? ""),
  );
}

/** HTML-escape a value interpolated into an email HTML body. The template is
 * operator-authored (trusted); the {{field}} VALUES come from entry data and MUST
 * be escaped, or a submitted value could inject markup/links into the branded
 * email (same untrusted-data discipline as the delivery surface). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip tags from a rendered HTML template into a readable plain-text fallback. */
export function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** interpolate(), but HTML-escaping each substituted value for an HTML body. */
function interpolateHtml(template: string, entry: { id: string; data?: Record<string, unknown> }): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    escapeHtml(key === "id" ? entry.id : String(entry.data?.[key] ?? "")),
  );
}

async function sendEmailAction(
  collection: Collection,
  event: string,
  action: Extract<EventAction, { type: "email" }>,
  entry: { id: string; data?: Record<string, unknown> },
  basePayload: Record<string, unknown>,
): Promise<void> {
  const rendered: RenderedEmail = {
    to: interpolate(action.to, entry),
    subject: interpolate(action.subject, entry),
    // With an html template: send the styled body + a tags-stripped text fallback
    // (values raw here, escaped in the html path). Without: the legacy notification.
    text: action.html
      ? htmlToText(interpolate(action.html, entry))
      : `${event} in "${collection.displayName}"\n\n${JSON.stringify(entry.data ?? { id: entry.id }, null, 2)}`,
    ...(action.html ? { html: interpolateHtml(action.html, entry) } : {}),
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
  /** Optional styled HTML body (values already escaped); sent alongside text. */
  html?: string;
}

/** Send one rendered email via the project's Resend connector; log the outcome.
 * Exported for the schedule_fire handler (G3) — collectionId is null there. */
export async function dispatchEmail(
  projectId: string,
  collectionId: string | null,
  event: string,
  rendered: RenderedEmail,
  logPayload: Record<string, unknown>,
): Promise<"success" | "failed"> {
  let status: "success" | "failed" = "failed";
  let lastError: string | null = null;
  try {
    if (!isValidEmailRecipient(rendered.to)) {
      throw new Error(`refusing to send: invalid recipient "${rendered.to.slice(0, 80)}"`);
    }
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
        ...(rendered.html ? { html: rendered.html } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) status = "success";
    else lastError = `Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
  try {
    await (await tenantDb(projectId)).insert(webhookDeliveries).values({
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
  const [row] = await (await tenantDb(projectId))
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.projectId, projectId)))
    .limit(1);
  if (!row) throw new ValidationError(`delivery ${deliveryId} not found`, "E_NOT_FOUND");

  // Inbound Stripe event logs (K4) use a `stripe:<type>` pseudo-url — they are
  // NOT outbound deliveries; re-POSTing that string would log garbage failures
  // (openMinor #7). Stripe redelivers from its own dashboard.
  if (row.url.startsWith("stripe:")) {
    throw new ValidationError(
      "inbound Stripe event logs are not refireable — redeliver from the Stripe dashboard instead",
    );
  }
  // I1a: before-write hook consults (event `hook.*`) gate a live write — there
  // is nothing to replay without a fresh write, so they are not refireable.
  if (row.event.startsWith("hook.")) {
    throw new ValidationError(
      "before-write hook consults cannot be replayed — re-attempt the write instead",
    );
  }

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
