import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tenantDb } from "./data-plane";
import { webhookTargetRefusal, guardedFetch } from "./net-guard";
import { projects, webhookDeliveries, type Collection, type WriteHook } from "@/db/schema";

/**
 * I1a: synchronous before-write hooks to BYO compute. A hook is consulted
 * inside the entries write choke point (createEntry) — MCP, admin, and delivery
 * writes all inherit it. The request is HMAC-signed with the project's webhook
 * signing secret (the SAME Stripe-style scheme as outbound event webhooks,
 * lib/webhook.ts), so the tenant endpoint authenticates AgentX with one shared
 * secret. Validate mode only GATES the write (never rewrites the candidate);
 * transform mode lands in I1b.
 *
 * Every consult logs a webhook_deliveries row (event `hook.before_create`) so a
 * rejected/failed write is visible in get_deliveries. Those rows are NOT
 * refireable — a before-write consult only makes sense against a live write.
 */

/** Run `fn` over `items` with at most `limit` in flight — a plain promise pool.
 * Bounds bulk before-create hook consults (I5) so N items take ceil(N/limit)
 * rounds, not N sequential timeouts. `fn` must handle its own errors. */
export async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export type HookOutcome =
  | { kind: "proceed" }
  /** transform mode returned {ok:true, data} — the FULL new entry data (I1b). */
  | { kind: "replace"; data: Record<string, unknown> }
  | { kind: "reject"; error: string; code?: string }
  /** Endpoint unreachable / timed out / malformed — onError decides the write. */
  | { kind: "unavailable"; reason: string };

export interface HookEnvelope {
  event: "entry.before_create" | "entry.before_update";
  collection: string;
  candidate: { data: Record<string, unknown> };
  current?: { data: Record<string, unknown> }; // update only (I1b)
}

const MAX_RESPONSE_BYTES = 256 * 1024;

/** Read a response body up to `max` bytes; null if it declares/streams past it. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseAck(text: string | null): { ok?: unknown; error?: unknown; code?: unknown; data?: unknown } | null {
  if (text === null) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

export async function callWriteHook(
  projectId: string,
  collection: Collection,
  hook: WriteHook,
  envelope: HookEnvelope,
  /** Override the logged delivery event — test_hook (I2) logs 'hook.test'. */
  logEvent?: string,
): Promise<HookOutcome> {
  const [proj] = await db
    .select({ secret: projects.webhookSigningSecret })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const secret = proj?.secret;

  const body = JSON.stringify(envelope);
  let outcome: HookOutcome;
  let responseSummary: Record<string, unknown>;

  // C4 SSRF guard — same rule as webhooks: no private/loopback targets from
  // our network. "unavailable" routes into each hook's onUnavailable policy.
  const targetRefusal = await webhookTargetRefusal(hook.url);

  if (targetRefusal) {
    outcome = { kind: "unavailable", reason: targetRefusal };
    responseSummary = { error: targetRefusal };
  } else if (!secret) {
    // validateHooks requires the secret at define time; if it was cleared since,
    // fail closed here rather than sending an UNSIGNED consult the tenant can't trust.
    outcome = { kind: "unavailable", reason: "project signing secret is not set" };
    responseSummary = { error: outcome.reason };
  } else {
    try {
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
      const res = await guardedFetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentx-signature": `t=${t},v1=${v1}`,
          "x-agentx-hook": "1",
        },
        body,
        signal: AbortSignal.timeout(hook.timeoutMs ?? 3000),
      });
      const ack = parseAck(await readCapped(res, MAX_RESPONSE_BYTES));
      if (!ack || !("ok" in ack)) {
        outcome = { kind: "unavailable", reason: `malformed hook response (HTTP ${res.status})` };
        responseSummary = { error: "malformed response", status: res.status };
      } else if (ack.ok === true) {
        // transform mode may return the FULL new entry data to write in place of
        // the candidate (I1b). validate mode ignores any data — it only gates.
        if (hook.mode === "transform" && ack.data && typeof ack.data === "object" && !Array.isArray(ack.data)) {
          outcome = { kind: "replace", data: ack.data as Record<string, unknown> };
          responseSummary = { ok: true, transformed: true, status: res.status };
        } else {
          outcome = { kind: "proceed" };
          responseSummary = { ok: true, status: res.status };
        }
      } else {
        const error = typeof ack.error === "string" && ack.error ? ack.error : "the hook rejected this write";
        outcome = { kind: "reject", error, code: typeof ack.code === "string" ? ack.code : undefined };
        responseSummary = { ok: false, error, status: res.status };
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      outcome = { kind: "unavailable", reason };
      responseSummary = { error: reason };
    }
  }

  // Always log the consult — a reject is a successful consult (the endpoint
  // answered); only unreachable/malformed is a delivery failure.
  const stage = envelope.event === "entry.before_create" ? "before_create" : "before_update";
  try {
    await (await tenantDb(projectId)).insert(webhookDeliveries).values({
      projectId,
      collectionId: collection.id,
      url: hook.url,
      event: logEvent ?? `hook.${stage}`,
      payload: { envelope, response: responseSummary },
      status: outcome.kind === "unavailable" ? "failed" : "success",
      attempts: "1",
      lastError:
        outcome.kind === "unavailable" ? outcome.reason : outcome.kind === "reject" ? outcome.error : null,
    });
  } catch {
    /* logging must never take down the write path */
  }
  return outcome;
}
