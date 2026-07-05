import { NextRequest } from "next/server";
import { bearerFrom, resolveProjectId } from "@/lib/tokens";
import { getCollection } from "@/lib/collections";
import { rateLimit } from "@/lib/ratelimit";
import { CORS_HEADERS, preflight } from "@/lib/cors";
import { gateRead, gateCreate, stampOwner } from "@/lib/access-rules";
import {
  createEntry,
  queryEntries,
  resolveRefsForRead,
  toPublicView,
  publicFields,
  ValidationError,
} from "@/lib/entries";
import type { WhereClause, WhereItem, OrderByClause } from "@/lib/query";

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

  // Identity gate (Phase 4): public / authenticated / owner.
  const gate = await gateRead(projectId, collection, req.headers.get("x-user-token"));
  if (!gate.ok) return corsJson({ error: gate.error }, { status: gate.status });

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  // ?select=a,b trims the projection; restricted to public fields like filters.
  let select: string[] | null = null;
  const selectParam = url.searchParams.get("select");
  if (selectParam !== null) {
    select = selectParam.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = select.find((name) => !pub.some((f) => f.name === name));
    if (select.length === 0 || bad !== undefined) {
      return corsJson(
        {
          error: `unknown or non-public select field "${bad ?? ""}" — selectable: ${pub.map((f) => f.name).join(", ")}`,
        },
        { status: 422 },
      );
    }
  }

  // Filters and sorting are restricted to PUBLIC fields — filtering on a
  // private field would leak its contents through result differences.
  const where: WhereClause[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "limit" || key === "offset" || key === "sort" || key === "select") continue;
    const field = pub.find((f) => f.name === key);
    if (!field) {
      return corsJson(
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
      return corsJson(
        { error: `sort must be "<public-field>:asc|desc" — sortable: ${pub.map((f) => f.name).join(", ")}` },
        { status: 422 },
      );
    }
    orderBy = { field, dir };
  }

  try {
    // Row gates first: declarative publicFilter, then the owner clause.
    const effectiveWhere = [
      ...((collection.publicFilter as WhereItem[] | null) ?? []),
      ...(gate.ownerClause ? [gate.ownerClause] : []),
      ...where,
    ];
    const rows = await queryEntries(collection, { limit, offset, where: effectiveWhere, orderBy });
    const resolved = await resolveRefsForRead(projectId, collection, rows);
    const data = resolved.map((e) => {
      const view = toPublicView(collection, e);
      if (!select) return view;
      const picked: Record<string, unknown> = { id: view.id };
      for (const name of select) if (name in view) picked[name] = view[name];
      return picked;
    });
    return corsJson({ data });
  } catch (e) {
    if (e instanceof ValidationError) {
      return corsJson({ error: e.message }, { status: 422 });
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

  // Identity gate: anonymous forms (publicWrite) or authenticated/owner creates.
  const gate = await gateCreate(projectId, collection, req.headers.get("x-user-token"));
  if (!gate.ok) return corsJson({ error: gate.error }, { status: gate.status });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limit = rateLimit(`${projectId}:${ip}`);
  if (!limit.allowed) {
    return corsJson(
      { error: "too many submissions — try again shortly" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return corsJson({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    // Authenticated creates get ownerField stamped from the verified JWT —
    // a user can never forge ownership. Events (webhook/email) fire from the
    // entries layer's single emit point.
    const data =
      body && typeof body === "object" && !Array.isArray(body)
        ? stampOwner(collection, gate.user, body as Record<string, unknown>)
        : body;
    const entry = await createEntry(projectId, collection, data, {
      actor: { type: "delivery", userSub: gate.user?.id },
    });
    return corsJson({ id: entry.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return corsJson({ error: e.message }, { status: 422 });
    }
    return corsJson({ error: "internal error" }, { status: 500 });
  }
}

function unauthorized() {
  return corsJson({ error: "invalid or missing project token" }, { status: 401 });
}
function notFound() {
  return corsJson({ error: "not found" }, { status: 404 });
}

export function OPTIONS() {
  return preflight();
}

function corsJson(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...CORS_HEADERS, ...(init?.headers ?? {}) },
  });
}
