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
import { preflight } from "@/lib/cors";
import { deliveryError, cachedJson } from "@/lib/delivery-http";
import type { Collection } from "@/db/schema";

/**
 * The change-feed delivery endpoint (H2) — the pull side of realtime.
 *
 *   GET /v1/changes?since=<cursor>&collections=a,b&limit=100
 *
 * Privacy is the INTERSECTION of write-time and CURRENT visibility (see
 * projectChangeForDelivery): broadening a collection's rules never exposes
 * history, narrowing hides immediately, a visible→hidden update becomes a
 * `deleted` tombstone, and a delete of a never-visible row is suppressed. One
 * poll covers a whole site; per-collection gates still apply per group of rows.
 */
export async function GET(req: NextRequest) {
  const tok = await resolveDeliveryToken(bearerFrom(req.headers.get("authorization")));
  if (!tok.ok) return deliveryError(401, tok.error, undefined, undefined, tok.code);
  const projectId = tok.projectId;

  const url = new URL(req.url);
  const userToken = req.headers.get("x-user-token");

  // Verify the end-user once for the whole project (issuer is per-project). A
  // token that was PRESENTED but is invalid is a client error; absent is fine
  // (public rows still flow).
  const auth = await verifyEndUser(projectId, userToken);
  if (auth.status === "invalid") return deliveryError(401, `invalid user token: ${auth.reason}`);
  const user = auth.status === "ok" ? auth.user : null;

  const collections = await listCollections(projectId);
  const byId = new Map<string, Collection>(collections.map((c) => [c.id, c]));
  const byName = new Map<string, Collection>(collections.map((c) => [c.name, c]));

  // ?collections=a,b restricts the feed. An explicitly-requested collection that
  // is unknown/non-public is a 422; one that fails its CURRENT read gate returns
  // that gate's own 401/503 (so a private request isn't silently empty).
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

  const limitParam = Number(url.searchParams.get("limit") ?? 100);
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 100, 1), 500);

  // Bootstrap: no cursor ⇒ empty page at the latest seq (client streams forward).
  const sinceParam = url.searchParams.get("since");
  if (sinceParam === null) {
    return cachedJson(req, { changes: [], cursor: encodeChangeCursor(await latestSeq(projectId)), hasMore: false });
  }

  let since: number;
  try {
    since = decodeChangeCursor(sinceParam);
  } catch (e) {
    if (e instanceof ValidationError) return deliveryError(422, e.message, undefined, e.issues);
    throw e;
  }
  const { changes: rows, hasMore, cursor } = await listChanges(projectId, { since, limit });

  const out = [];
  for (const row of rows) {
    if (filter && !filter.has(row.collectionName)) continue;
    const current = byId.get(row.collectionId) ?? null;
    // A non-orphaned collection with zero public fields exposes nothing.
    if (current && publicFields(current).length === 0) continue;
    const projected = projectChangeForDelivery(row, current, user, encodeChangeCursor);
    if (projected) out.push(projected);
  }

  // The cursor advances past EVERY raw row (including dropped ones), so a client
  // never re-fetches a gated row it will never be shown.
  return cachedJson(req, { changes: out, cursor: encodeChangeCursor(cursor), hasMore });
}

export function OPTIONS() {
  return preflight();
}
