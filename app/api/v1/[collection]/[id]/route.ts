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
import { gateRead, gateMutate, stampedIdentityFields, checkFieldWrites } from "@/lib/access-rules";
import { getLocales, hasLocalizedFields, localizeView } from "@/lib/locales";
import { rateLimit } from "@/lib/ratelimit";
import { readBounded, MAX_DELIVERY_BODY_BYTES } from "@/lib/http";
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

/** Per-project/per-IP throttle for the mutating handlers — F1 lets a claim-write
 * role mutate ANY row (with webhook/email fan-out), so PATCH/DELETE need the same
 * window POST/search already enforce. Returns a 429 Response when over budget. */
async function throttle(req: NextRequest, projectId: string) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = await rateLimit(`${projectId}:${ip}`, { projectId });
  if (!rl.allowed) {
    return err(429, "too many requests — try again shortly", {
      headers: { "retry-after": String(rl.retryAfterSec) },
    });
  }
  return null;
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

  // Row gates: identity clauses (owner + org) and publicFilter — all as 404
  // (never confirm existence to someone the row is scoped away from).
  if (!matchesClauses(collection.fields, gate.rowClauses ?? [], entry.data)) {
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
    await expandRelations(projectId, collection, [entry], expand, "public", gate.user);
  }

  const [resolved] = await resolveRefsForRead(projectId, collection, [entry], gate.user);
  // J4/J6: localized variant maps flatten to ONE locale — ?locale=xx when
  // requested (validated, per-variant fallback to default), else the default.
  let requestedLocale: string | undefined;
  const localeParam = new URL(req.url).searchParams.get("locale");
  let locales = hasLocalizedFields(collection.fields) ? await getLocales(projectId) : null;
  if (localeParam !== null) {
    if (!locales) locales = await getLocales(projectId);
    const tag = localeParam.trim().toLowerCase();
    if (!locales || !locales.supported.includes(tag)) {
      return err(
        422,
        locales
          ? `unknown locale "${localeParam}" — supported: ${locales.supported.join(", ")} (default ${locales.default})`
          : "this project has no locales configured — ?locale= is not available",
      );
    }
    requestedLocale = tag;
  }
  const view = localizeView(
    toPublicView(collection, resolved) as Record<string, unknown>,
    collection.fields,
    locales,
    requestedLocale,
  );

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
    const reverse = await includeReverse(projectId, collection, [resolved.id], specs, "public", gate.user);
    const rel = reverse.get(resolved.id);
    if (rel) view.related = rel;
  }

  // Same shareability rule as the list route: pure function of (token, URL).
  const share = req.headers.get("x-user-token") === null && (gate.rowClauses ?? []).length === 0;
  return cachedJson(req, { data: view }, { share });
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

  const limited = await throttle(req, projectId);
  if (limited) return limited;

  const raw = await readBounded(req, MAX_DELIVERY_BODY_BYTES);
  if (raw === null) return err(413, "request body too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return err(400, "invalid JSON body");
  }

  // Server-set identity fields (owner + org) are immutable through this endpoint —
  // strip them so a row owner can't re-assign ownership or move a row's org.
  if (body && typeof body === "object") {
    for (const f of stampedIdentityFields(collection)) {
      delete (body as Record<string, unknown>)[f];
    }
    // Field-level write gates (F4), after the identity strip.
    const blocked = checkFieldWrites(collection, gate.user, body as Record<string, unknown>);
    if (blocked.length > 0) {
      return err(
        403,
        `fields [${blocked.join(", ")}] are not writable via the delivery API here — remove them or sign in with the required role`,
      );
    }
  }

  try {
    const updated = await updateEntry(projectId, collection, id, body, {
      type: "delivery",
      userSub: gate.user?.id,
    });
    const [resolved] = await resolveRefsForRead(projectId, collection, [updated], gate.user);
    const locales = hasLocalizedFields(collection.fields) ? await getLocales(projectId) : null;
    return corsJson({
      data: localizeView(toPublicView(collection, resolved), collection.fields, locales),
    });
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

  const limited = await throttle(req, projectId);
  if (limited) return limited;

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
