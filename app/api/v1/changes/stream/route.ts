import { NextRequest } from "next/server";
import { bearerFrom, resolveDeliveryToken } from "@/lib/tokens";
import { listCollections } from "@/lib/collections";
import { verifyEndUser } from "@/lib/user-auth";
import { gateRead } from "@/lib/access-rules";
import {
  listChanges,
  latestSeq,
  projectChangeForDelivery,
  encodeChangeCursor,
  decodeChangeCursor,
} from "@/lib/changes";
import { publicFields, ValidationError } from "@/lib/entries";
import { CORS_HEADERS, preflight } from "@/lib/cors";
import { deliveryError } from "@/lib/delivery-http";

/**
 * SSE change stream (H4) — the push-shaped read of the same feed H2 serves by
 * poll. Same auth + intersection gate; a bounded lifetime turns it into
 * long-poll on hosts that cut long connections (Netlify). GET /v1/changes is the
 * guaranteed-everywhere floor; reconnect with ?since or Last-Event-ID.
 */
export const dynamic = "force-dynamic";

const POLL_MS = Number(process.env.CHANGES_POLL_MS) || 2000;
const PING_MS = 15_000;
// Netlify cuts long function invocations, so degrade to a short long-poll there.
const LIFETIME_CAP_MS = process.env.NETLIFY ? 8_000 : Number(process.env.CHANGES_STREAM_MAX_MS) || 55_000;

// Cheap in-process concurrency brake (per-lambda on serverless, exact locally) —
// each stream pins an invocation polling pg, and delivery tokens are public.
const MAX_STREAMS_PER_PROJECT = 5;
const active = new Map<string, number>();

export async function GET(req: NextRequest) {
  const tok = await resolveDeliveryToken(bearerFrom(req.headers.get("authorization")));
  if (!tok.ok) return deliveryError(401, tok.error, undefined, undefined, tok.code);
  const projectId = tok.projectId;

  const userToken = req.headers.get("x-user-token");
  const auth = await verifyEndUser(projectId, userToken);
  if (auth.status === "invalid") return deliveryError(401, `invalid user token: ${auth.reason}`);
  const user = auth.status === "ok" ? auth.user : null;

  const url = new URL(req.url);
  const collections = await listCollections(projectId);
  const byName = new Map(collections.map((c) => [c.name, c]));

  // ?collections=a,b — same validation as the poll endpoint.
  let filter: Set<string> | null = null;
  const collectionsParam = url.searchParams.get("collections");
  if (collectionsParam !== null) {
    filter = new Set(collectionsParam.split(",").map((s) => s.trim()).filter(Boolean));
    for (const name of filter) {
      const c = byName.get(name);
      if (!c || publicFields(c).length === 0) {
        const exposed = collections.filter((x) => publicFields(x).length > 0).map((x) => x.name);
        return deliveryError(422, `unknown or non-public collection "${name}" — exposed: ${exposed.join(", ")}`);
      }
      const gate = await gateRead(projectId, c, userToken);
      if (!gate.ok) return deliveryError(gate.status, gate.error);
    }
  }

  // Resume point: ?since or Last-Event-ID; absent ⇒ stream forward from now.
  const sinceParam = url.searchParams.get("since") ?? req.headers.get("last-event-id");
  let cursor: number;
  try {
    cursor = sinceParam ? decodeChangeCursor(sinceParam) : await latestSeq(projectId);
  } catch (e) {
    if (e instanceof ValidationError) return deliveryError(422, e.message, undefined, e.issues);
    throw e;
  }

  // Bounded lifetime — client-requestable but clamped to the host cap (so the
  // smoke can ask for a short stream; real clients reconnect on the cursor frame).
  const reqMax = Number(url.searchParams.get("maxMs"));
  const maxMs = Math.min(Number.isFinite(reqMax) && reqMax > 0 ? reqMax : LIFETIME_CAP_MS, LIFETIME_CAP_MS);

  if ((active.get(projectId) ?? 0) >= MAX_STREAMS_PER_PROJECT) {
    return deliveryError(429, "too many concurrent streams for this project — reconnect shortly or use GET /v1/changes");
  }
  active.set(projectId, (active.get(projectId) ?? 0) + 1);
  const release = () => active.set(projectId, Math.max(0, (active.get(projectId) ?? 1) - 1));

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      const started = Date.now();
      let lastPing = started;
      send(": open\n\n"); // flush headers promptly past proxies
      try {
        while (Date.now() - started < maxMs) {
          // Re-read collections each tick so a visibility change applies mid-stream.
          const cols = await listCollections(projectId);
          const byId = new Map(cols.map((c) => [c.id, c]));
          const { changes: rows, cursor: next } = await listChanges(projectId, { since: cursor, limit: 500 });
          for (const row of rows) {
            if (filter && !filter.has(row.collectionName)) continue;
            const current = byId.get(row.collectionId) ?? null;
            if (current && publicFields(current).length === 0) continue;
            const projected = projectChangeForDelivery(row, current, user, encodeChangeCursor);
            if (projected) send(`id: ${projected.cursor}\nevent: change\ndata: ${JSON.stringify(projected)}\n\n`);
          }
          cursor = next;
          if (Date.now() - lastPing >= PING_MS) {
            send(": ping\n\n");
            lastPing = Date.now();
          }
          const remaining = maxMs - (Date.now() - started);
          if (remaining <= 0) break;
          await new Promise((r) => setTimeout(r, Math.min(POLL_MS, remaining)));
        }
        // Clean close: hand back the cursor so the client resumes exactly here.
        send(`event: cursor\ndata: ${JSON.stringify({ cursor: encodeChangeCursor(cursor) })}\n\n`);
      } catch {
        /* connection dropped or a transient read failed — just close */
      } finally {
        release();
        controller.close();
      }
    },
    cancel() {
      release();
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

export function OPTIONS() {
  return preflight();
}
