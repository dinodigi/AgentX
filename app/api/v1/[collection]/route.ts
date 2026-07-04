import { NextRequest, after } from "next/server";
import { bearerFrom, resolveProjectId } from "@/lib/tokens";
import { getCollection } from "@/lib/collections";
import { deliverWebhook } from "@/lib/webhook";
import { rateLimit } from "@/lib/ratelimit";
import {
  createEntry,
  queryEntries,
  resolveRefsForRead,
  toPublicView,
  publicFields,
  ValidationError,
} from "@/lib/entries";
import type { WhereClause, OrderByClause } from "@/lib/query";

/**
 * Delivery API — what the live site consumes. Scoped per-project by the same
 * bearer token (the site's server env holds it).
 *
 *   GET  /v1/{collection}  → rows projected to ONLY publicRead fields,
 *                            relations resolved to {id,label}. 404 if the
 *                            collection exposes no public fields (per-field gate).
 *   POST /v1/{collection}  → only when the collection is publicWrite. Validates,
 *                            stores, fires the collection webhook. A form = a
 *                            public-write collection; submissions land in the admin.
 */

async function resolve(req: NextRequest, name: string) {
  const token = bearerFrom(req.headers.get("authorization"));
  const projectId = token ? await resolveProjectId(token) : null;
  if (!projectId) return { error: unauthorized() };
  const collection = await getCollection(projectId, name);
  if (!collection) return { error: notFound() };
  return { projectId, collection };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ collection: string }> },
) {
  const { collection: name } = await params;
  const r = await resolve(req, name);
  if ("error" in r) return r.error;
  const { projectId, collection } = r;

  // Per-field gate: no public fields => nothing to expose.
  const pub = publicFields(collection);
  if (pub.length === 0) return notFound();

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  // Filters and sorting are restricted to PUBLIC fields — filtering on a
  // private field would leak its contents through result differences.
  const where: WhereClause[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "limit" || key === "offset" || key === "sort") continue;
    const field = pub.find((f) => f.name === key);
    if (!field) {
      return Response.json(
        {
          error: `unknown or non-public filter field "${key}" — filterable: ${pub.map((f) => f.name).join(", ")}`,
        },
        { status: 422 },
      );
    }
    where.push({ field: key, op: "eq", value: coerceParam(field.type, value) });
  }

  let orderBy: OrderByClause | undefined;
  const sort = url.searchParams.get("sort");
  if (sort) {
    const [field, dir = "asc"] = sort.split(":");
    if (!pub.some((f) => f.name === field) || (dir !== "asc" && dir !== "desc")) {
      return Response.json(
        { error: `sort must be "<public-field>:asc|desc" — sortable: ${pub.map((f) => f.name).join(", ")}` },
        { status: 422 },
      );
    }
    orderBy = { field, dir };
  }

  try {
    // publicFilter first: declarative row visibility set on the collection.
    const effectiveWhere = [...((collection.publicFilter as WhereClause[] | null) ?? []), ...where];
    const rows = await queryEntries(collection, { limit, offset, where: effectiveWhere, orderBy });
    const resolved = await resolveRefsForRead(projectId, collection, rows);
    const data = resolved.map((e) => toPublicView(collection, e));
    return Response.json({ data });
  } catch (e) {
    if (e instanceof ValidationError) {
      return Response.json({ error: e.message }, { status: 422 });
    }
    throw e;
  }
}

function coerceParam(type: string, value: string): string | number | boolean {
  if (type === "number") return Number(value);
  if (type === "boolean") return value === "true";
  return value;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ collection: string }> },
) {
  const { collection: name } = await params;
  const r = await resolve(req, name);
  if ("error" in r) return r.error;
  const { projectId, collection } = r;

  if (!collection.publicWrite) {
    return Response.json(
      { error: "public write is not enabled for this collection" },
      { status: 403 },
    );
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limit = rateLimit(`${projectId}:${ip}`);
  if (!limit.allowed) {
    return Response.json(
      { error: "too many submissions — try again shortly" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const entry = await createEntry(projectId, collection, body);
    // No email engine — webhook and stop. Retries + outcome log run after the
    // response is sent, so submitters never wait on a slow webhook endpoint.
    if (collection.webhookUrl) {
      const url = collection.webhookUrl;
      after(() =>
        deliverWebhook({
          projectId,
          collectionId: collection.id,
          url,
          event: "entry.created",
          payload: { collection: collection.name, entry: { id: entry.id, data: entry.data } },
        }),
      );
    }
    return Response.json({ id: entry.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return Response.json({ error: e.message }, { status: 422 });
    }
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

function unauthorized() {
  return Response.json({ error: "invalid or missing project token" }, { status: 401 });
}
function notFound() {
  return Response.json({ error: "not found" }, { status: 404 });
}
