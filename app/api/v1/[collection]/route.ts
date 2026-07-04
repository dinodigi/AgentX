import { NextRequest } from "next/server";
import { bearerFrom, resolveProjectId } from "@/lib/tokens";
import { getCollection } from "@/lib/collections";
import {
  createEntry,
  queryEntries,
  resolveRelations,
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
    const rows = await queryEntries(collection, { limit, offset, where, orderBy });
    const resolved = await resolveRelations(projectId, collection, rows);
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const entry = await createEntry(projectId, collection, body);
    // No email engine — fire the webhook and stop. Fire-and-forget.
    if (collection.webhookUrl) void fireWebhook(collection.webhookUrl, collection.name, entry);
    return Response.json({ id: entry.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return Response.json({ error: e.message }, { status: 422 });
    }
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

async function fireWebhook(url: string, collection: string, entry: unknown) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "entry.created", collection, entry }),
    });
  } catch {
    // Best-effort; delivery of the webhook is not guaranteed in v1.
  }
}

function unauthorized() {
  return Response.json({ error: "invalid or missing project token" }, { status: 401 });
}
function notFound() {
  return Response.json({ error: "not found" }, { status: 404 });
}
