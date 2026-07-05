import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { entries, assets, collections, type Collection, type Entry } from "@/db/schema";
import { buildEntrySchema, formatZodError, ValidationError, type RefCheck } from "./validation";
import { buildWhere, buildOrderBy, type WhereItem, type OrderByClause } from "./query";
import { emitEntryEvent } from "./events";
import { recordAudit } from "./audit";
import type { AuditActor } from "@/db/schema";

const UNKNOWN_ACTOR: AuditActor = { type: "unknown" };
import type { FieldDef } from "./field-types";
import { z } from "zod";

/**
 * Entry CRUD with full validation. Every write goes through buildEntrySchema
 * (shape + type + enum + required) and then verifyRefs (relation/asset ids
 * actually exist). This is what "an AI can't corrupt stored data" means in
 * practice.
 *
 * Every Neon query is an HTTPS round-trip, so this module batches aggressively:
 * one query for all asset refs, one per target collection for relation refs,
 * one for all relation labels — never one query per field.
 */

export { ValidationError };

/** Check that relation/asset ids referenced by an entry exist in this project. */
async function verifyRefs(
  projectId: string,
  data: Record<string, unknown>,
  refChecks: RefCheck[],
): Promise<void> {
  const assetIds: { field: string; id: string }[] = [];
  const relByTarget = new Map<string, { field: string; id: string }[]>();

  for (const ref of refChecks) {
    const value = data[ref.field];
    if (value == null) continue; // optional / not provided
    if (ref.kind === "asset") {
      assetIds.push({ field: ref.field, id: value as string });
    } else {
      const list = relByTarget.get(ref.targetCollection!) ?? [];
      list.push({ field: ref.field, id: value as string });
      relByTarget.set(ref.targetCollection!, list);
    }
  }
  if (assetIds.length === 0 && relByTarget.size === 0) return;

  const checks: Promise<void>[] = [];

  if (assetIds.length > 0) {
    checks.push(
      db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            inArray(assets.id, assetIds.map((a) => a.id)),
            eq(assets.projectId, projectId),
          ),
        )
        .then((found) => {
          const ok = new Set(found.map((f) => f.id));
          for (const a of assetIds) {
            if (!ok.has(a.id)) throw new ValidationError(`${a.field}: asset ${a.id} not found`);
          }
        }),
    );
  }

  for (const [targetName, refs] of relByTarget) {
    checks.push(
      db
        .select({ id: entries.id })
        .from(entries)
        .innerJoin(collections, eq(entries.collectionId, collections.id))
        .where(
          and(
            inArray(entries.id, refs.map((r) => r.id)),
            eq(collections.projectId, projectId),
            eq(collections.name, targetName),
          ),
        )
        .then((found) => {
          const ok = new Set(found.map((f) => f.id));
          for (const r of refs) {
            if (!ok.has(r.id)) {
              throw new ValidationError(`${r.field}: no entry ${r.id} in "${targetName}"`);
            }
          }
        }),
    );
  }

  await Promise.all(checks);
}

function validate(
  fields: FieldDef[],
  data: unknown,
  partial: boolean,
): Record<string, unknown> {
  const { schema } = buildEntrySchema(fields, partial);
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof z.ZodError) throw new ValidationError(formatZodError(e));
    throw e;
  }
}

export async function createEntry(
  projectId: string,
  collection: Collection,
  data: unknown,
  opts: { idempotencyKey?: string; actor?: AuditActor } = {},
): Promise<Entry> {
  const clean = validate(collection.fields, data, false);
  const { refChecks } = buildEntrySchema(collection.fields);
  await verifyRefs(projectId, clean, refChecks);

  const [row] = await db
    .insert(entries)
    .values({
      projectId,
      collectionId: collection.id,
      data: clean,
      idempotencyKey: opts.idempotencyKey ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (row) {
    void emitEntryEvent(collection, "created", { id: row.id, data: row.data });
    recordAudit({
      projectId,
      collectionName: collection.name,
      entryId: row.id,
      action: "create",
      actor: opts.actor ?? UNKNOWN_ACTOR,
      changedFields: Object.keys(clean),
    });
    return row;
  }

  // Conflict = this idempotency key already created an entry; return it.
  const [existing] = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.collectionId, collection.id),
        eq(entries.idempotencyKey, opts.idempotencyKey!),
      ),
    )
    .limit(1);
  return existing;
}

export async function updateEntry(
  projectId: string,
  collection: Collection,
  id: string,
  data: unknown,
  actor: AuditActor = UNKNOWN_ACTOR,
): Promise<Entry> {
  const patch = validate(collection.fields, data, true);
  const { refChecks } = buildEntrySchema(collection.fields, true);

  // Ref checks and the current-row fetch are independent — run together.
  const [, current] = await Promise.all([
    verifyRefs(projectId, patch, refChecks),
    db
      .select()
      .from(entries)
      .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id)))
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (!current) throw new ValidationError(`entry ${id} not found`, "E_NOT_FOUND");

  const merged = { ...current.data, ...patch };
  const [row] = await db
    .update(entries)
    .set({ data: merged, updatedAt: new Date() })
    .where(eq(entries.id, id))
    .returning();
  void emitEntryEvent(collection, "updated", { id: row.id, data: row.data });
  recordAudit({
    projectId,
    collectionName: collection.name,
    entryId: row.id,
    action: "update",
    actor,
    changedFields: Object.keys(patch),
  });
  return row;
}

export async function deleteEntry(
  collection: Collection,
  id: string,
  actor: AuditActor = UNKNOWN_ACTOR,
): Promise<void> {
  const [row] = await db
    .delete(entries)
    .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id)))
    .returning();
  if (row) {
    void emitEntryEvent(collection, "deleted", { id: row.id, data: row.data });
    recordAudit({
      projectId: collection.projectId,
      collectionName: collection.name,
      entryId: row.id,
      action: "delete",
      actor,
    });
  }
}

export async function getEntry(collection: Collection, id: string): Promise<Entry | null> {
  const [row] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.id, id), eq(entries.collectionId, collection.id)))
    .limit(1);
  return row ?? null;
}

export async function countEntries(
  collection: Collection,
  where: WhereItem[] = [],
): Promise<number> {
  const conditions = [
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, where),
  ];
  const [row] = await db
    .select({ n: count() })
    .from(entries)
    .where(and(...conditions));
  return row?.n ?? 0;
}

export interface BulkItemResult {
  index: number;
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Validate every item, then insert all valid ones in ONE statement. Per-item
 * results so an agent can fix just its failures — a partial seed beats an
 * all-or-nothing retry of 50 round-trips.
 */
export async function bulkCreateEntries(
  projectId: string,
  collection: Collection,
  items: unknown[],
  actor: AuditActor = UNKNOWN_ACTOR,
): Promise<BulkItemResult[]> {
  if (items.length > 100) throw new ValidationError("max 100 entries per bulk call");
  const { refChecks } = buildEntrySchema(collection.fields);

  const results: BulkItemResult[] = [];
  const valid: { index: number; clean: Record<string, unknown> }[] = [];
  await Promise.all(
    items.map(async (item, index) => {
      try {
        const clean = validate(collection.fields, item, false);
        await verifyRefs(projectId, clean, refChecks);
        valid.push({ index, clean });
      } catch (e) {
        results.push({ index, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  if (valid.length > 0) {
    const rows = await db
      .insert(entries)
      .values(
        valid.map((v) => ({ projectId, collectionId: collection.id, data: v.clean })),
      )
      .returning();
    valid.forEach((v, i) => {
      results.push({ index: v.index, ok: true, id: rows[i].id });
      void emitEntryEvent(collection, "created", { id: rows[i].id, data: rows[i].data });
      recordAudit({
        projectId,
        collectionName: collection.name,
        entryId: rows[i].id,
        action: "create",
        actor,
        changedFields: Object.keys(v.clean),
      });
    });
  }
  return results.sort((a, b) => a.index - b.index);
}

export interface QueryOpts {
  limit?: number;
  offset?: number;
  where?: WhereItem[];
  orderBy?: OrderByClause;
}

export const MAX_QUERY_LIMIT = 500;

export interface EntryPage {
  rows: Entry[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Page-aware query: fetches limit+1 rows so hasMore is exact, never a guess.
 * Without an explicit orderBy, rows are ordered by (createdAt, id) — pagination
 * needs a total order or pages can overlap/skip.
 */
export async function queryEntriesPage(
  collection: Collection,
  opts: QueryOpts = {},
): Promise<EntryPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, MAX_QUERY_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);
  const conditions = [
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, opts.where ?? []),
  ];
  const order = buildOrderBy(collection.fields, opts.orderBy);

  let q = db.select().from(entries).where(and(...conditions)).$dynamic();
  q = order ? q.orderBy(order, entries.id) : q.orderBy(entries.createdAt, entries.id);
  const rows = await q.limit(limit + 1).offset(offset);
  return { rows: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit };
}

export async function queryEntries(
  collection: Collection,
  opts: QueryOpts = {},
): Promise<Entry[]> {
  return (await queryEntriesPage(collection, opts)).rows;
}

/**
 * Resolve relation values on a set of entries to { id, label } using each
 * relation's labelField. ONE query for all referenced ids across every
 * relation field, regardless of how many relation fields the schema has.
 */
export async function resolveRelations(
  projectId: string,
  collection: Collection,
  rows: Entry[],
): Promise<Entry[]> {
  const relationFields = collection.fields.filter(
    (f): f is Extract<FieldDef, { type: "relation" }> => f.type === "relation",
  );
  if (relationFields.length === 0 || rows.length === 0) return rows;

  const allIds = new Set<string>();
  for (const rf of relationFields) {
    for (const r of rows) {
      const v = r.data[rf.name];
      if (typeof v === "string") allIds.add(v);
    }
  }
  if (allIds.size === 0) return rows;

  // Entry ids are globally unique — one fetch covers every target collection.
  const targetRows = await db
    .select({ id: entries.id, data: entries.data })
    .from(entries)
    .where(and(inArray(entries.id, [...allIds]), eq(entries.projectId, projectId)));
  const byId = new Map(targetRows.map((t) => [t.id, t.data]));

  for (const rf of relationFields) {
    for (const r of rows) {
      const v = r.data[rf.name];
      if (typeof v === "string" && byId.has(v)) {
        const data = byId.get(v)!;
        r.data[rf.name] = { id: v, label: String(data[rf.labelField] ?? v) };
      }
    }
  }
  return rows;
}

/**
 * Resolve asset values on a set of entries to { id, url } — same batched
 * pattern as relations. Without this, delivery consumers get bare uuids and
 * agents invent dual-field workarounds (see experiment friction log F2).
 */
export async function resolveAssets(
  projectId: string,
  collection: Collection,
  rows: Entry[],
): Promise<Entry[]> {
  const assetFields = collection.fields.filter((f) => f.type === "asset");
  if (assetFields.length === 0 || rows.length === 0) return rows;

  const ids = new Set<string>();
  for (const f of assetFields) {
    for (const r of rows) {
      const v = r.data[f.name];
      if (typeof v === "string") ids.add(v);
    }
  }
  if (ids.size === 0) return rows;

  const found = await db
    .select({ id: assets.id, url: assets.url })
    .from(assets)
    .where(and(inArray(assets.id, [...ids]), eq(assets.projectId, projectId)));
  const byId = new Map(found.map((a) => [a.id, a.url]));

  for (const f of assetFields) {
    for (const r of rows) {
      const v = r.data[f.name];
      if (typeof v === "string" && byId.has(v)) {
        r.data[f.name] = { id: v, url: byId.get(v)! };
      }
    }
  }
  return rows;
}

/** Relations + assets in one pass (disjoint fields — safe to run together). */
export async function resolveRefsForRead(
  projectId: string,
  collection: Collection,
  rows: Entry[],
): Promise<Entry[]> {
  await Promise.all([
    resolveRelations(projectId, collection, rows),
    resolveAssets(projectId, collection, rows),
  ]);
  return rows;
}

/** Project an entry's data down to only fields flagged publicRead. */
/** Validate a select list against a collection's fields. Throws with the field list. */
export function validateSelect(fields: FieldDef[], select: string[]): void {
  if (select.length === 0) {
    throw new ValidationError("select: needs at least one field name");
  }
  const valid = new Set(fields.map((f) => f.name));
  for (const name of select) {
    if (!valid.has(name)) {
      throw new ValidationError(
        `select: unknown field "${name}" — valid fields: ${fields.map((f) => f.name).join(", ")}`,
      );
    }
  }
}

/** Project entry data down to the selected fields (validation is the caller's job). */
export function projectData(
  data: Record<string, unknown>,
  select: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of select) if (name in data) out[name] = data[name];
  return out;
}

export function toPublicView(collection: Collection, entry: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: entry.id };
  for (const f of collection.fields) {
    if (f.publicRead && f.name in entry.data) out[f.name] = entry.data[f.name];
  }
  return out;
}

/** The public-read fields of a collection (empty => not exposed at all). */
export function publicFields(collection: Collection): FieldDef[] {
  return collection.fields.filter((f) => f.publicRead);
}
