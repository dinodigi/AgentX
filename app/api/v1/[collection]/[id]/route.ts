import { NextRequest } from "next/server";
import { bearerFrom, resolveProjectId } from "@/lib/tokens";
import { getCollection } from "@/lib/collections";
import {
  getEntry,
  updateEntry,
  deleteEntry,
  resolveRefsForRead,
  expandRelations,
  includeReverse,
  toPublicView,
  publicFields,
  ValidationError,
} from "@/lib/entries";
import type { ConstraintIssue } from "@/lib/validation";
import { matchesClauses } from "@/lib/query";
import { gateRead, gateMutate } from "@/lib/access-rules";
import { CORS_HEADERS, preflight } from "@/lib/cors";
import { corsJson, deliveryError, cachedJson } from "@/lib/delivery-http";

/**
 * Single-entry delivery endpoints (Phase 4).
 *
 *   GET    /v1/{collection}/{id} — read rules apply (owner sees only own rows)
 *   PATCH  /v1/{collection}/{id} — write:"owner" only, own rows only
 *   DELETE /v1/{collection}/{id} — write:"owner" only, own rows only
 */

async function resolve(req: NextRequest, name: string) {
  const token = bearerFrom(req.headers.get("authorization"));
  const projectId = token ? await resolveProjectId(token) : null;
  if (!projectId) return { error: err(401, "invalid or missing project token") };
  const collection = await getCollection(projectId, name);
  if (!collection) return { error: err(404, "not found") };
  return { projectId, collection };
}

type Params = { params: Promise<{ collection: string; id: string }> };

// Non-uuid ids (including stray GETs to /uploads) 404 before touching the DB.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: Params) {
  const { collection: name, id } = await params;
  if (!UUID_RE.test(id)) return err(404, "not found");
  const r = await resolve(req, name);
  if ("error" in r) return r.error;
  const { projectId, collection } = r;

  if (publicFields(collection).length === 0) return err(404, "not found");
  const gate = await gateRead(projectId, collection, req.headers.get("x-user-token"));
  if (!gate.ok) return err(gate.status, gate.error);

  const entry = await getEntry(collection, id);
  if (!entry) return err(404, "not found");

  // Row gates: owner match + publicFilter, both as 404 (never confirm existence).
  if (gate.ownerClause && entry.data[gate.ownerClause.field] !== gate.ownerClause.value) {
    return err(404, "not found");
  }
  if (!matchesClauses(collection.fields, collection.publicFilter ?? [], entry.data)) {
    return err(404, "not found");
  }

  const expandParam = new URL(req.url).searchParams.get("expand");
  if (expandParam) {
    const expand = expandParam.split(",").map((s) => s.trim()).filter(Boolean);
    const pub = publicFields(collection);
    for (const nm of expand) {
      const f = pub.find((x) => x.name === nm && x.type === "relation") as
        | Extract<(typeof pub)[number], { type: "relation" }>
        | undefined;
      if (!f) return err(422, `cannot expand "${nm}" — not a public relation field`);
      const target = await getCollection(projectId, f.targetCollection);
      const targetRead = (target?.access as { read?: string } | null)?.read;
      if (!target || publicFields(target).length === 0 || (targetRead && targetRead !== "public")) {
        return err(422, `cannot expand "${nm}" — target "${f.targetCollection}" is not publicly readable`);
      }
    }
    await expandRelations(projectId, collection, [entry], expand, "public");
  }

  const [resolved] = await resolveRefsForRead(projectId, collection, [entry]);
  const view = toPublicView(collection, resolved) as Record<string, unknown>;

  const includeParam = new URL(req.url).searchParams.get("include");
  if (includeParam) {
    const parts = includeParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
    const specs: { collection: string; field: string }[] = [];
    for (const part of parts) {
      const [childName, relField] = part.split(".");
      if (!childName || !relField) return err(422, `include "${part}" must be "childCollection.relationField"`);
      const childColl = await getCollection(projectId, childName);
      const childRead = (childColl?.access as { read?: string } | null)?.read;
      if (!childColl || publicFields(childColl).length === 0 || (childRead && childRead !== "public")) {
        return err(422, `include "${part}" — child collection "${childName}" is not publicly readable`);
      }
      if (!publicFields(childColl).some((f) => f.name === relField && f.type === "relation")) {
        return err(422, `include "${part}" — "${relField}" is not a public relation field on "${childName}"`);
      }
      specs.push({ collection: childName, field: relField });
    }
    const reverse = await includeReverse(projectId, collection, [resolved.id], specs, "public");
    const rel = reverse.get(resolved.id);
    if (rel) view.related = rel;
  }

  return cachedJson(req, { data: view });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { collection: name, id } = await params;
  if (!UUID_RE.test(id)) return err(404, "not found");
  const r = await resolve(req, name);
  if ("error" in r) return r.error;
  const { projectId, collection } = r;

  const entry = await getEntry(collection, id);
  if (!entry) return err(404, "not found");

  const gate = await gateMutate(projectId, collection, req.headers.get("x-user-token"), entry.data);
  if (!gate.ok) return err(gate.status, gate.error);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid JSON body");
  }

  // Ownership is immutable through this endpoint.
  const ownerField = collection.access?.ownerField;
  if (body && typeof body === "object" && ownerField && ownerField in (body as object)) {
    delete (body as Record<string, unknown>)[ownerField];
  }

  try {
    const updated = await updateEntry(projectId, collection, id, body, {
      type: "delivery",
      userSub: gate.user?.id,
    });
    const [resolved] = await resolveRefsForRead(projectId, collection, [updated]);
    return corsJson({ data: toPublicView(collection, resolved) });
  } catch (e) {
    if (e instanceof ValidationError) return err(422, e.message, undefined, e.issues);
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { collection: name, id } = await params;
  if (!UUID_RE.test(id)) return err(404, "not found");
  const r = await resolve(req, name);
  if ("error" in r) return r.error;
  const { projectId, collection } = r;

  const entry = await getEntry(collection, id);
  if (!entry) return err(404, "not found");

  const gate = await gateMutate(projectId, collection, req.headers.get("x-user-token"), entry.data);
  if (!gate.ok) return err(gate.status, gate.error);

  await deleteEntry(collection, id, { type: "delivery", userSub: gate.user?.id });
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function err(
  status: number,
  error: string,
  init?: ResponseInit,
  issues?: ConstraintIssue[],
) {
  return deliveryError(status, error, init, issues);
}

export function OPTIONS() {
  return preflight();
}
