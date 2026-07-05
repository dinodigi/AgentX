import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { entries, assets, collections, type Collection, type Entry } from "@/db/schema";
import { buildEntrySchema, formatZodError, ValidationError, type RefCheck } from "./validation";
import { accessor, buildWhere, buildOrderBy, type WhereItem, type OrderByClause } from "./query";
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

/** Full searchable text of a DB error (message + constraint name if exposed). */
function dbErrorText(e: unknown): string {
  const constraint = String((e as { constraint?: string }).constraint ?? "");
  return (e instanceof Error ? e.message : String(e)) + " " + constraint;
}

/** Map partial-unique-index violations (23505) to agent-repairable errors. */
function rethrowUnique(e: unknown): never {
  const m = /entries_uq_[0-9a-f]{8}_([a-z][a-z0-9_]*)/.exec(dbErrorText(e));
  if (m) {
    throw new ValidationError(`${m[1]}: value already exists — this field is unique`);
  }
  throw e;
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

  // Conflicts are handled explicitly (not onConflictDoNothing) so an
  // idempotency replay and a unique-field violation stay distinguishable.
  let row: Entry | undefined;
  try {
    [row] = await db
      .insert(entries)
      .values({
        projectId,
        collectionId: collection.id,
        data: clean,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning();
  } catch (e) {
    if (!/entries_idempotency_idx/.test(dbErrorText(e))) rethrowUnique(e);
  }
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
  let row: Entry;
  try {
    [row] = await db
      .update(entries)
      .set({ data: merged, updatedAt: new Date() })
      .where(eq(entries.id, id))
      .returning();
  } catch (e) {
    rethrowUnique(e);
  }
  void emitEntryEvent(collection, "updated", { id: row.id, data: row.data }, current.data);
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

export interface UpdateIfOpts {
  /** Conditions on the CURRENT row, re-checked atomically inside the UPDATE. */
  if?: WhereItem[];
  /** Ordinary validated patch (merged like update_entry). */
  data?: unknown;
  /** Atomic increment computed in SQL from the old value — never read-modify-write. */
  increment?: { field: string; by: number };
  actor?: AuditActor;
}

export type UpdateIfResult =
  | { ok: true; entry: Entry }
  | { ok: false; reason: "not_found" | "conflict" };

/**
 * Compare-and-set in ONE SQL statement — the 80/20 of transactions
 * (book-a-seat) with zero code execution. The if-conditions AND the field's
 * min/max constraint guards live in the UPDATE's WHERE clause, so concurrent
 * writers serialize on the row instead of racing validation.
 */
export async function updateEntryIf(
  projectId: string,
  collection: Collection,
  id: string,
  opts: UpdateIfOpts,
): Promise<UpdateIfResult> {
  const patch = opts.data !== undefined ? validate(collection.fields, opts.data, true) : {};
  if (opts.data !== undefined) {
    const { refChecks } = buildEntrySchema(collection.fields, true);
    await verifyRefs(projectId, patch, refChecks);
  }
  if (Object.keys(patch).length === 0 && !opts.increment) {
    throw new ValidationError("update_entry_if needs data and/or increment — nothing to apply");
  }

  const conditions = [
    eq(entries.id, id),
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, opts.if ?? []),
  ];

  let dataExpr = sql`${entries.data}`;
  if (Object.keys(patch).length > 0) {
    dataExpr = sql`${dataExpr} || ${JSON.stringify(patch)}::jsonb`;
  }

  let incField: FieldDef | undefined;
  if (opts.increment) {
    const { field, by } = opts.increment;
    incField = collection.fields.find((f) => f.name === field);
    if (!incField || incField.type !== "number") {
      const numberFields = collection.fields.filter((f) => f.type === "number").map((f) => f.name);
      throw new ValidationError(
        `increment: needs a number field — number fields: ${numberFields.join(", ") || "(none)"}`,
      );
    }
    if (field in patch) {
      throw new ValidationError(`increment: "${field}" cannot also appear in data — pick one`);
    }
    const oldValue = sql`(${entries.data}->>${field})::numeric`;
    // The field must exist to increment, and the result must respect the
    // field's min/max constraints — violations surface as a conflict, which is
    // exactly the book-a-seat semantic ("no seats left").
    conditions.push(sql`${entries.data} ? ${field}`);
    if (incField.min !== undefined) conditions.push(sql`${oldValue} + ${by} >= ${incField.min}`);
    if (incField.max !== undefined) conditions.push(sql`${oldValue} + ${by} <= ${incField.max}`);
    dataExpr = sql`jsonb_set(${dataExpr}, ${`{${field}}`}, to_jsonb(${oldValue} + ${by}))`;
  }

  let row: Entry | undefined;
  try {
    [row] = await db
      .update(entries)
      .set({ data: dataExpr as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
  } catch (e) {
    rethrowUnique(e);
  }

  if (!row) {
    const exists = await getEntry(collection, id);
    return { ok: false, reason: exists ? "conflict" : "not_found" };
  }

  void emitEntryEvent(collection, "updated", { id: row.id, data: row.data });
  recordAudit({
    projectId,
    collectionName: collection.name,
    entryId: row.id,
    action: "update",
    actor: opts.actor ?? UNKNOWN_ACTOR,
    changedFields: [...Object.keys(patch), ...(opts.increment ? [opts.increment.field] : [])],
  });
  return { ok: true, entry: row };
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
    // One multi-row insert; a unique violation fails the whole batch with the
    // field named, rather than paying a round-trip per item.
    let rows: Entry[];
    try {
      rows = await db
        .insert(entries)
        .values(
          valid.map((v) => ({ projectId, collectionId: collection.id, data: v.clean })),
        )
        .returning();
    } catch (e) {
      rethrowUnique(e);
    }
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
  /** Keyset position from decodeCursor — only valid with the default ordering. */
  after?: { createdAt: Date; id: string };
}

/** Opaque cursor over the default (createdAt, id) ordering. */
export function encodeCursor(row: Entry): string {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), id: row.id }),
  ).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      t?: unknown;
      id?: unknown;
    };
    const createdAt = new Date(String(parsed.t));
    if (Number.isNaN(createdAt.getTime()) || typeof parsed.id !== "string" || !parsed.id) {
      throw new Error("bad cursor");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new ValidationError(
      "invalid cursor — pass the nextCursor returned by a previous query_entries page",
    );
  }
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
  // Cursor keys truncate to milliseconds because JS Dates lose Postgres's
  // microseconds — both sides of the keyset comparison must share a precision,
  // and the default ordering must sort by the exact same key.
  const createdMs = sql`date_trunc('milliseconds', ${entries.createdAt})`;
  if (opts.after) {
    if (opts.orderBy) {
      throw new ValidationError(
        "cursor pagination uses the default (createdAt, id) ordering — drop orderBy, or page with offset instead",
      );
    }
    conditions.push(
      sql`(${createdMs}, ${entries.id}) > (${opts.after.createdAt.toISOString()}::timestamptz, ${opts.after.id}::uuid)`,
    );
  }
  const order = buildOrderBy(collection.fields, opts.orderBy);

  let q = db.select().from(entries).where(and(...conditions)).$dynamic();
  q = order ? q.orderBy(order, entries.id) : q.orderBy(createdMs, entries.id);
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
export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";
export interface AggregateSpec {
  fn: AggregateFn;
  field?: string;
}

export const MAX_AGGREGATE_GROUPS = 500;

export interface AggregateResult {
  /** One entry per group; a single group with key null when groupBy is absent. */
  groups: { key: string | null; label?: string; values: (number | null)[] }[];
  /** True when more than MAX_AGGREGATE_GROUPS groups exist (largest kept). */
  truncated: boolean;
}

/**
 * Aggregations without fetching rows: count/sum/avg/min/max over number
 * fields, optionally grouped by an enum or relation field (relation group
 * keys resolve to their target's labelField). Same validated where
 * vocabulary as queries; same "reject with a fix hint" discipline.
 */
export async function aggregateEntries(
  collection: Collection,
  opts: { aggregates: AggregateSpec[]; groupBy?: string; where?: WhereItem[] },
): Promise<AggregateResult> {
  const numberFields = collection.fields.filter((f) => f.type === "number");
  const selects: Record<string, ReturnType<typeof sql>> = {};
  opts.aggregates.forEach((spec, i) => {
    if (spec.fn === "count") {
      if (spec.field !== undefined) {
        throw new ValidationError('aggregates: "count" counts rows — omit field');
      }
      selects[`a${i}`] = sql`count(*)`;
      return;
    }
    if (!spec.field) {
      throw new ValidationError(`aggregates: "${spec.fn}" needs a field`);
    }
    const f = collection.fields.find((x) => x.name === spec.field);
    if (!f || f.type !== "number") {
      throw new ValidationError(
        `aggregates: "${spec.fn}" needs a number field — number fields: ${
          numberFields.map((x) => x.name).join(", ") || "(none)"
        }`,
      );
    }
    // fn is enum-validated above, so sql.raw is safe.
    selects[`a${i}`] = sql`${sql.raw(spec.fn)}(${accessor(f)})`;
  });

  const conditions = [
    eq(entries.collectionId, collection.id),
    ...buildWhere(collection.fields, opts.where ?? []),
  ];

  const toValues = (row: Record<string, unknown>) =>
    opts.aggregates.map((_, i) => (row[`a${i}`] === null ? null : Number(row[`a${i}`])));

  if (!opts.groupBy) {
    const [row] = await db.select(selects).from(entries).where(and(...conditions));
    return { groups: [{ key: null, values: toValues(row) }], truncated: false };
  }

  const groupField = collection.fields.find((f) => f.name === opts.groupBy);
  if (!groupField || (groupField.type !== "enum" && groupField.type !== "relation")) {
    const groupable = collection.fields
      .filter((f) => f.type === "enum" || f.type === "relation")
      .map((f) => f.name);
    throw new ValidationError(
      `groupBy: needs an enum or relation field — groupable: ${groupable.join(", ") || "(none)"}`,
    );
  }

  // Group/order by ordinal: repeating the parametrized JSONB expression would
  // get fresh parameter numbers and Postgres would refuse to match them.
  const keyExpr = sql`${entries.data}->>${groupField.name}`;
  const rows = await db
    .select({ key: keyExpr, ...selects })
    .from(entries)
    .where(and(...conditions))
    .groupBy(sql`1`)
    .orderBy(sql`count(*) DESC`, sql`1`)
    .limit(MAX_AGGREGATE_GROUPS + 1);

  const truncated = rows.length > MAX_AGGREGATE_GROUPS;
  const groups: AggregateResult["groups"] = rows.slice(0, MAX_AGGREGATE_GROUPS).map((row) => ({
    key: row.key === null ? null : String(row.key),
    values: toValues(row),
  }));

  // Relation group keys are target-entry ids; resolve their labels in one query.
  if (groupField.type === "relation") {
    const ids = groups.map((g) => g.key).filter((k): k is string => k !== null);
    if (ids.length > 0) {
      const [target] = await db
        .select()
        .from(collections)
        .where(
          and(
            eq(collections.projectId, collection.projectId),
            eq(collections.name, groupField.targetCollection),
          ),
        )
        .limit(1);
      if (target) {
        const labelRows = await db
          .select({ id: entries.id, label: sql`${entries.data}->>${groupField.labelField}` })
          .from(entries)
          .where(and(eq(entries.collectionId, target.id), inArray(entries.id, ids)));
        const labels = new Map(labelRows.map((r) => [r.id, r.label === null ? "" : String(r.label)]));
        for (const g of groups) {
          if (g.key !== null && labels.has(g.key)) g.label = labels.get(g.key);
        }
      }
    }
  }

  return { groups, truncated };
}

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
