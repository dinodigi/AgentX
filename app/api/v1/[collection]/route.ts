import { NextRequest } from "next/server";
import { bearerFrom, resolveProjectId } from "@/lib/tokens";
import { getCollection } from "@/lib/collections";
import { rateLimit } from "@/lib/ratelimit";
import { searchEntriesPage, publicSearchableFields } from "@/lib/search";
import { preflight } from "@/lib/cors";
import { corsJson, deliveryError, cachedJson } from "@/lib/delivery-http";
import { gateRead, gateCreate, stampIdentity, checkFieldWrites } from "@/lib/access-rules";
import {
  createEntry,
  queryEntries,
  resolveRefsForRead,
  expandRelations,
  includeReverse,
  collectRelatedTargets,
  toPublicView,
  publicFields,
  ValidationError,
} from "@/lib/entries";
import { getLocales, hasLocalizedFields, localizeView } from "@/lib/locales";
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
  if (!gate.ok) return deliveryError(gate.status, gate.error);

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  // J6: ?locale=xx switches which variant localized fields serve (per-variant
  // fallback to the default). Validated against the project registry; ETag
  // correctness is free (cachedJson hashes the localized body).
  let requestedLocale: string | undefined;
  const localeParam = url.searchParams.get("locale");
  let locales = hasLocalizedFields(collection.fields) ? await getLocales(projectId) : null;
  if (localeParam !== null) {
    if (!locales) locales = await getLocales(projectId);
    const tag = localeParam.trim().toLowerCase();
    if (!locales || !locales.supported.includes(tag)) {
      return deliveryError(
        422,
        locales
          ? `unknown locale "${localeParam}" — supported: ${locales.supported.join(", ")} (default ${locales.default})`
          : "this project has no locales configured — ?locale= is not available",
      );
    }
    requestedLocale = tag;
  }

  // ?select=a,b trims the projection; restricted to public fields like filters.
  let select: string[] | null = null;
  const selectParam = url.searchParams.get("select");
  if (selectParam !== null) {
    select = selectParam.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = select.find((name) => !pub.some((f) => f.name === name));
    if (select.length === 0 || bad !== undefined) {
      return deliveryError(
        422,
        `unknown or non-public select field "${bad ?? ""}" — selectable: ${pub.map((f) => f.name).join(", ")}`,
      );
    }
  }

  // ?expand=author,category expands publicRead relation fields to {id,label,data}.
  // The target collection must be publicly readable (>=1 publicRead field and
  // access.read public/absent); its row visibility (publicFilter) is applied.
  let expand: string[] | null = null;
  const expandParam = url.searchParams.get("expand");
  if (expandParam !== null) {
    expand = expandParam.split(",").map((s) => s.trim()).filter(Boolean);
    for (const name of expand) {
      const f = pub.find((x) => x.name === name && x.type === "relation") as
        | Extract<(typeof pub)[number], { type: "relation" }>
        | undefined;
      if (!f) {
        const expandable = pub.filter((x) => x.type === "relation").map((x) => x.name);
        return deliveryError(
          422,
          `cannot expand "${name}" — expandable public relation fields: ${expandable.join(", ") || "(none)"}`,
        );
      }
      const target = await getCollection(projectId, f.targetCollection);
      const targetRead = (target?.access as { read?: string } | null)?.read;
      if (!target || publicFields(target).length === 0 || (targetRead && targetRead !== "public")) {
        return deliveryError(
          422,
          `cannot expand "${name}" — target collection "${f.targetCollection}" is not publicly readable`,
        );
      }
    }
  }

  // Filters and sorting are restricted to PUBLIC fields — filtering on a
  // private field would leak its contents through result differences.
  const where: WhereClause[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (
      key === "limit" ||
      key === "offset" ||
      key === "sort" ||
      key === "select" ||
      key === "expand" ||
      key === "include" ||
      key === "q" ||
      key === "locale"
    )
      continue;

    // A "relationField.targetField" key is a related filter (?author.name=X).
    // It must reference a PUBLIC relation head, a PUBLICLY-READABLE target, and a
    // PUBLIC tail — the target's own row visibility (publicFilter) is then ANDed
    // inside the subquery so a match implies the related row is publicly visible.
    if (key.includes(".")) {
      const head = key.slice(0, key.indexOf("."));
      const tail = key.slice(key.indexOf(".") + 1);
      const headField = pub.find((f) => f.name === head && f.type === "relation") as
        | Extract<(typeof pub)[number], { type: "relation" }>
        | undefined;
      if (!headField) {
        return deliveryError(
          422,
          `cannot filter by "${key}" — "${head}" is not a public relation field on this collection`,
        );
      }
      const target = await getCollection(projectId, headField.targetCollection);
      const targetRead = (target?.access as { read?: string } | null)?.read;
      if (!target || publicFields(target).length === 0 || (targetRead && targetRead !== "public")) {
        return deliveryError(
          422,
          `cannot filter by "${key}" — target collection "${headField.targetCollection}" is not publicly readable; related filters are only allowed against targets you could GET directly`,
        );
      }
      const tailField = publicFields(target).find((f) => f.name === tail);
      if (!tailField) {
        return deliveryError(
          422,
          `cannot filter by "${key}" — "${tail}" is not a public field on "${headField.targetCollection}"`,
        );
      }
      where.push({ field: key, op: "eq", value: coerceParam(tailField.type, value) });
      continue;
    }

    const field = pub.find((f) => f.name === key);
    if (!field) {
      return deliveryError(
        422,
        `unknown or non-public filter field "${key}" — filterable: ${pub.map((f) => f.name).join(", ")}`,
      );
    }
    where.push({ field: key, op: "eq", value: coerceParam(field.type, value) });
  }

  // ?include=comments.post,likes.post embeds children that reference each row.
  // The child collection must be publicly readable; its publicFilter is applied.
  let includeSpecs: { collection: string; field: string }[] | null = null;
  const includeParam = url.searchParams.get("include");
  if (includeParam !== null) {
    const parts = includeParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 3) return deliveryError(422, "include: at most 3 child paths");
    includeSpecs = [];
    for (const part of parts) {
      const [childName, relField] = part.split(".");
      if (!childName || !relField) {
        return deliveryError(422, `include "${part}" must be "childCollection.relationField"`);
      }
      const childColl = await getCollection(projectId, childName);
      const childRead = (childColl?.access as { read?: string } | null)?.read;
      if (!childColl || publicFields(childColl).length === 0 || (childRead && childRead !== "public")) {
        return deliveryError(422, `include "${part}" — child collection "${childName}" is not publicly readable`);
      }
      // The back-reference field must ALSO be publicRead: grouping children by it
      // discloses child.<field> === parent.id, so a private back-ref would leak.
      if (!publicFields(childColl).some((f) => f.name === relField && f.type === "relation")) {
        return deliveryError(
          422,
          `include "${part}" — "${relField}" is not a public relation field on "${childName}"`,
        );
      }
      includeSpecs.push({ collection: childName, field: relField });
    }
  }

  let orderBy: OrderByClause | undefined;
  const sort = url.searchParams.get("sort");
  if (sort) {
    const [field, dir = "asc"] = sort.split(":");
    if (!pub.some((f) => f.name === field) || (dir !== "asc" && dir !== "desc")) {
      return deliveryError(
        422,
        `sort must be "<public-field>:asc|desc" — sortable: ${pub.map((f) => f.name).join(", ")}`,
      );
    }
    orderBy = { field, dir };
  }

  // ?q= full-text search over the PUBLIC searchable subset, rank-ordered.
  const q = url.searchParams.get("q");
  if (q !== null) {
    if (publicSearchableFields(collection.fields).length === 0) {
      return deliveryError(
        422,
        "search is not enabled for this collection — no public searchable fields; mark a searchable field publicRead via define_collection",
      );
    }
    if (sort) return deliveryError(422, "search results are rank-ordered — drop ?sort");
    // Keyword search is CPU-bound SQL on an unauthenticated GET — rate-limit it.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const rl = await rateLimit(`${projectId}:${ip}`);
    if (!rl.allowed) {
      return deliveryError(429, "too many searches — try again shortly", {
        headers: { "retry-after": String(rl.retryAfterSec) },
      });
    }
  }

  try {
    // Row gates first: declarative publicFilter, then the owner clause.
    const effectiveWhere = [
      ...((collection.publicFilter as WhereItem[] | null) ?? []),
      ...(gate.rowClauses ?? []),
      ...where,
    ];
    const related = await collectRelatedTargets(projectId, collection, effectiveWhere, "delivery");
    const rows =
      q !== null
        ? (
            await searchEntriesPage(collection, {
              q,
              fields: publicSearchableFields(collection.fields),
              where: effectiveWhere,
              limit,
              offset,
            })
          ).rows
        : await queryEntries(collection, { limit, offset, where: effectiveWhere, orderBy, related });
    if (expand) await expandRelations(projectId, collection, rows, expand, "public", gate.user);
    const resolved = await resolveRefsForRead(projectId, collection, rows, gate.user);
    const reverse = includeSpecs
      ? await includeReverse(projectId, collection, resolved.map((r) => r.id), includeSpecs, "public", gate.user)
      : undefined;
    // J4/J6: flatten localized variant maps AFTER the public projection —
    // ?locale= variant when requested, per-variant fallback to the default.
    const data = resolved.map((e) => {
      const view = localizeView(toPublicView(collection, e), collection.fields, locales, requestedLocale);
      const rel = reverse?.get(e.id);
      if (!select) return rel ? { ...view, related: rel } : view;
      const picked: Record<string, unknown> = { id: view.id };
      for (const name of select) if (name in view) picked[name] = view[name];
      if (rel) picked.related = rel;
      return picked;
    });
    return cachedJson(req, { data });
  } catch (e) {
    if (e instanceof ValidationError) {
      return deliveryError(422, e.message, undefined, e.issues);
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
  if (!gate.ok) return deliveryError(gate.status, gate.error);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limit = await rateLimit(`${projectId}:${ip}`);
  if (!limit.allowed) {
    return deliveryError(429, "too many submissions — try again shortly", {
      headers: { "retry-after": String(limit.retryAfterSec) },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return deliveryError(400, "invalid JSON body");
  }

  // Field-level write gates (F4): reject writableBy fields the caller can't write.
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const blocked = checkFieldWrites(collection, gate.user, body as Record<string, unknown>);
    if (blocked.length > 0) {
      return deliveryError(
        403,
        `fields [${blocked.join(", ")}] are not writable via the delivery API here — remove them or sign in with the required role`,
      );
    }
  }

  try {
    // Authenticated creates get ownerField stamped from the verified JWT —
    // a user can never forge ownership. Events (webhook/email) fire from the
    // entries layer's single emit point.
    const data =
      body && typeof body === "object" && !Array.isArray(body)
        ? stampIdentity(collection, gate.user, body as Record<string, unknown>)
        : body;
    const entry = await createEntry(projectId, collection, data, {
      actor: { type: "delivery", userSub: gate.user?.id },
      // I1b: on a transform, re-stamp ownership from THIS verified identity —
      // a hook can never move ownership (anonymous ⇒ owner/org stripped).
      identity: { user: gate.user },
    });
    return corsJson({ id: entry.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      // I1a: a before-write hook rejection is 422 E_HOOK_REJECTED; an
      // unreachable/malformed hook (fail-closed) is 502 E_HOOK_FAILED — distinct
      // from a plain E_VALIDATION so delivery clients branch correctly.
      if (e.code === "E_HOOK_FAILED") return deliveryError(502, e.message, undefined, undefined, "E_HOOK_FAILED");
      if (e.code === "E_HOOK_REJECTED") return deliveryError(422, e.message, undefined, undefined, "E_HOOK_REJECTED");
      return deliveryError(422, e.message, undefined, e.issues);
    }
    return deliveryError(500, "internal error");
  }
}

function unauthorized() {
  return deliveryError(401, "invalid or missing project token");
}
function notFound() {
  return deliveryError(404, "not found");
}

export function OPTIONS() {
  return preflight();
}
