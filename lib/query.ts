import { sql, and, type SQL, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { entries } from "@/db/schema";
import { fieldLocalized, fieldWriteOnly, type FieldDef } from "./field-types";
import { ValidationError } from "./validation";

/**
 * Schema-validated filtering + sorting over JSONB entry data. Every clause is
 * checked against the collection's field defs before any SQL is built, so an
 * agent (or the public API) can never filter/sort on a field that doesn't
 * exist, use an operator that doesn't fit the type, or inject anything.
 */

export const WHERE_OPS = ["eq", "ne", "neOrUnset", "contains", "gt", "lt", "in", "has", "exists"] as const;
export type WhereOp = (typeof WHERE_OPS)[number];

/**
 * C2 — a RELATIVE time, resolved at evaluation time. Negative goes forward:
 * {hoursAgo: 0} is now, {hoursAgo: -24} is 24h from now.
 *
 * Deliberately the SAME vocabulary `define_schedule` already accepts, because
 * the reporter's point was that the language existed and simply was not wired
 * to where clauses — inventing a second spelling for the same idea would be the
 * worse outcome.
 */
export type RelativeTime = { daysAgo: number } | { hoursAgo: number };

export interface WhereClause {
  field: string;
  op: WhereOp;
  /** `in` takes a string[]; every other op takes a scalar or a RelativeTime. */
  value: string | number | boolean | string[] | RelativeTime;
}

/** Is this value the {daysAgo}/{hoursAgo} shape? */
export function isRelativeTime(v: unknown): v is RelativeTime {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    (typeof o.daysAgo === "number" && Number.isFinite(o.daysAgo)) ||
    (typeof o.hoursAgo === "number" && Number.isFinite(o.hoursAgo))
  );
}

/** Resolve a RelativeTime against NOW. */
export function resolveRelativeTime(v: RelativeTime, now = Date.now()): string {
  const hours = "daysAgo" in v ? v.daysAgo * 24 : v.hoursAgo;
  return new Date(now - hours * 3_600_000).toISOString();
}

/** C2: does any clause carry a relative time? Such a filter is TIME-VARYING,
 *  so its responses cannot be honestly edge-cached. */
export function hasRelativeTime(items: WhereItem[] | undefined): boolean {
  if (!items?.length) return false;
  return items.some((i) =>
    "anyOf" in i ? i.anyOf.some((c) => isRelativeTime(c.value)) : isRelativeTime(i.value),
  );
}

/**
 * One item of a where[] list: a clause, or an OR group of clauses.
 * Items AND together; inside anyOf, clauses OR together. Exactly one nesting
 * level — no expression language.
 */
export type WhereItem = WhereClause | { anyOf: WhereClause[] };

export interface OrderByClause {
  field: string;
  dir: "asc" | "desc";
}

/** Which operators make sense per primitive. */
const OPS_BY_TYPE: Record<FieldDef["type"], WhereOp[]> = {
  text: ["eq", "ne", "neOrUnset", "contains", "in", "exists"],
  richtext: ["contains", "exists"],
  number: ["eq", "ne", "neOrUnset", "gt", "lt", "exists"],
  boolean: ["eq", "ne", "neOrUnset", "exists"],
  date: ["eq", "ne", "neOrUnset", "gt", "lt", "exists"],
  enum: ["eq", "ne", "neOrUnset", "in", "exists"],
  asset: ["eq", "ne", "neOrUnset", "exists"],
  relation: ["eq", "ne", "neOrUnset", "in", "exists"],
  // Structured fields aren't filterable/sortable — no ops means any where/orderBy
  // on a group is rejected with a clear message (v1 scope guard).
  group: [],
  // C1: an array of SCALARS supports membership (`has`). Computed per field by
  // opsForField below, because it depends on the item type, not just "array".
  array: [],
};

/**
 * B3 — `id` is a COLUMN on entries, not a key inside `data`, so it was absent
 * from the schema field list and every where/orderBy on it was rejected with
 * "unknown field id". That made the most ordinary query there is — fetch these
 * three rows by id — impossible without N round trips.
 *
 * It is exposed as a virtual text field. `contains` is deliberately not offered
 * (substring matching a uuid is a footgun, not a feature); eq/ne/in cover the
 * real use, and `exists` is meaningless on a primary key.
 *
 * A collection MAY define its own field called `id`; a real field always wins,
 * so this can never shadow existing data.
 */
const VIRTUAL_ID: FieldDef = { name: "id", label: "ID", type: "text" } as FieldDef;
const ID_OPS: WhereOp[] = ["eq", "ne", "in"];

/**
 * C1 — the ops a specific field supports.
 *
 * A tag archive used to fetch every row and filter in memory: "correct at 5
 * posts and wrong at 500", and the generated client's filter type advertised
 * `tags`, which implied otherwise. An array of SCALARS is a set, and a set
 * supports membership — so those fields get `has`. An array of GROUPS is
 * structured content and stays unfilterable.
 */
export function opsForField(f: FieldDef): WhereOp[] {
  if (f.type !== "array") return OPS_BY_TYPE[f.type];
  const item = (f as { item?: { type?: string } }).item;
  if (!item || item.type === "group") return [];
  return ["has", "exists"];
}

/** C1: is this an array of scalars, i.e. a filterable set? */
export const isScalarArray = (f: FieldDef) => opsForField(f).includes("has");

/** A3: a date field whose index (and therefore comparison) is text-based. */
const isIndexedDate = (f: FieldDef) => f.type === "date" && f.indexed === true;

/**
 * A3: a date comparison value in the SAME canonical form writes are stored in
 * (`new Date(s).toISOString()`), so a text comparison is exact.
 *
 * An unparseable value throws rather than silently comparing as raw text — on
 * the text path a garbage value would not error the way `::timestamptz` did, it
 * would just quietly match the wrong rows, and a filter that returns a
 * confidently wrong set is worse than one that fails.
 */
function canonicalDateValue(f: FieldDef, value: unknown): string {
  const s = String(value);
  const t = Date.parse(s);
  if (Number.isNaN(t)) {
    throw new ValidationError(
      `where: "${s}" is not a valid date for field "${f.name}" — use an ISO 8601 value like 2026-07-28T12:00:00Z`,
    );
  }
  return new Date(t).toISOString();
}

function fieldOrThrow(fields: FieldDef[], name: string, context: string): FieldDef {
  const f = fields.find((x) => x.name === name);
  if (!f) {
    if (name === "id") return VIRTUAL_ID;
    throw new ValidationError(
      `${context}: unknown field "${name}" — valid fields: ${[...fields.map((x) => x.name), "id"].join(", ")}`,
    );
  }
  // J4: a localized value is a {locale: string} map — no single SQL accessor
  // fits it, so every filter/sort path rejects it here at the shared gate.
  if (fieldLocalized(f)) {
    throw new ValidationError(
      `${context}: "${name}" is a localized field — localized fields cannot be filtered or sorted; use a non-localized field`,
    );
  }
  // SEC-1: a filter is a READ with extra steps. `password_hash eq "..."` returns
  // nothing but answers the question, and `contains` turns into a byte-at-a-time
  // extraction; sorting leaks the ordering. This ONE gate covers query where,
  // orderBy, publicFilter, events/hook/transition `when`, and update_entry_if
  // conditions, because every one of them compiles through here — including at
  // define time, so a schema that filters on a secret is refused before it can
  // ever run.
  if (fieldWriteOnly(f)) {
    throw new ValidationError(
      `${context}: "${name}" is a write-only field — it can be written but never read, and a filter or sort on it is a read (an eq/contains probe would answer "is the value X?"). Gate on a non-write-only field instead.`,
    );
  }
  return f;
}

/** JSONB text accessor for a field, cast per type where needed. `dataCol` lets
 *  a related-filter subquery read the ALIASED target's data column. */
export function accessor(field: FieldDef, dataCol: AnyColumn | SQL = entries.data): SQL {
  // B3: the virtual id reads the COLUMN, never data->>'id'. Cast to text so it
  // compares against the string ids callers actually hold.
  //
  // It is only meaningful against the primary `entries` row. A gate clause
  // compiled over an ALIASED table (a target's publicFilter inside an EXISTS)
  // would otherwise silently emit the OUTER table's id and quietly return the
  // wrong rows — so that combination is refused rather than guessed at.
  if (field === VIRTUAL_ID) {
    if (dataCol !== entries.data) {
      throw new ValidationError(
        `where: "id" refers to the entry's own id and cannot be used inside a related-collection gate — filter the relation field itself instead`,
      );
    }
    return sql`${entries.id}::text`;
  }
  // C1: an array is compared as JSONB (containment), never as text.
  if (field.type === "array") return sql`${dataCol}->${field.name}`;
  const raw = sql`${dataCol}->>${field.name}`;
  switch (field.type) {
    case "number":
      return sql`(${raw})::numeric`;
    case "date":
      // A3: an INDEXED date compares as raw TEXT, because its index must be a
      // text index (Postgres refuses a ::timestamptz expression index — the
      // cast is STABLE). A ::timestamptz lhs here would make the planner ignore
      // that index entirely, which would leave `indexed: true` a lie.
      //
      // This is not a second semantics for dates. Stored values are fixed-width
      // canonical UTC ISO, and the comparison value is canonicalized to the
      // same form below, so text ordering and instant ordering are the SAME
      // ordering. The unindexed path keeps the cast because its values have not
      // been backfilled and may carry a non-canonical offset.
      return isIndexedDate(field) ? raw : sql`(${raw})::timestamptz`;
    case "boolean":
      return sql`(${raw})::boolean`;
    default:
      return raw;
  }
}

/**
 * Per-relation-field context that authorizes a dotted `relationField.targetField`
 * filter. Built by collectRelatedTargets (lib/entries.ts) per surface policy:
 * MCP reads bypass the target's row gates; delivery reads AND the target's
 * publicFilter inside the EXISTS so a match implies the related row is visible.
 */
export interface RelatedContext {
  collectionId: string;
  /** Fields the TAIL may reference (delivery: publicRead only; MCP: all). */
  queryFields: FieldDef[];
  /** Fields the gate clauses may reference (all target fields — publicFilter
   *  may gate on private fields). */
  gateFields: FieldDef[];
  /** ANDed inside the EXISTS (delivery: the target's publicFilter; MCP: []). */
  gateClauses: WhereItem[];
  /** Ops permitted for this surface (MCP: full; delivery: {eq,in}). */
  allowedOps: Set<WhereOp>;
}
export type RelatedContextMap = Map<string, RelatedContext>;

/** A compiled where item plus a human/agent-readable label for the guard. */
export interface WherePart {
  /** e.g. `seats gt 0` or `status eq "open" OR status eq "paid"`. */
  label: string;
  sql: SQL;
}

function labelClause(c: WhereClause): string {
  return `${c.field} ${c.op} ${JSON.stringify(c.value)}`;
}

/**
 * Upper bounds on the size of a compiled where. Uncapped, a single request can
 * build hundreds of thousands of clauses — a multi-MB SQL string that OOMs the
 * instance and 502s every project until Render restarts (scorecard D4). This is
 * the authoritative backstop: it guards every caller — delivery, MCP, and a
 * stored `publicFilter` re-run on each read — regardless of any input schema.
 */
export const MAX_WHERE_ITEMS = 100;
export const MAX_ANYOF_ITEMS = 200;

/**
 * Validate + compile where items to labeled SQL fragments. `buildWhere` and the
 * CAS failure diagnosis share this ONE compilation path so a diagnostic SELECT
 * evaluates byte-identical predicates to the UPDATE it is explaining.
 */
export function buildWhereParts(
  fields: FieldDef[],
  where: WhereItem[],
  related?: RelatedContextMap,
): WherePart[] {
  if (where.length > MAX_WHERE_ITEMS) {
    throw new ValidationError(`where: too many clauses (${where.length} > ${MAX_WHERE_ITEMS})`);
  }
  return where.map((item) => {
    if ("anyOf" in item) {
      if (!Array.isArray(item.anyOf) || item.anyOf.length === 0) {
        throw new ValidationError("where: anyOf needs a non-empty array of clauses");
      }
      if (item.anyOf.length > MAX_ANYOF_ITEMS) {
        throw new ValidationError(`where: anyOf too large (${item.anyOf.length} > ${MAX_ANYOF_ITEMS})`);
      }
      const conds = item.anyOf.map((c) => {
        if (typeof c !== "object" || c === null || "anyOf" in c) {
          throw new ValidationError("where: anyOf cannot nest another anyOf — one level only");
        }
        return compileClause(fields, c, related);
      });
      return {
        label: item.anyOf.map(labelClause).join(" OR "),
        sql: conds.length === 1 ? conds[0] : sql`(${sql.join(conds, sql` OR `)})`,
      };
    }
    return { label: labelClause(item), sql: compileClause(fields, item, related) };
  });
}

/** Validate + compile where items (clauses + OR groups) to SQL conditions. Throws ValidationError. */
export function buildWhere(
  fields: FieldDef[],
  where: WhereItem[],
  related?: RelatedContextMap,
): SQL[] {
  return buildWhereParts(fields, where, related).map((p) => p.sql);
}

/** Validate op + value shape, then compile the clause over an accessor (lhs). */
function compileScalarClause(
  f: FieldDef,
  clause: WhereClause,
  lhs: SQL,
  allowedOps?: Set<WhereOp>,
): SQL {
  // B3: the virtual id is text-shaped but not a text field — it takes eq/ne/in
  // only. `contains` on a uuid invites a substring scan that looks like it
  // works; `exists` is always true on a primary key.
  const base = f === VIRTUAL_ID ? ID_OPS : opsForField(f);
  const ops = allowedOps ? base.filter((o) => allowedOps.has(o)) : base;
  if (!ops.includes(clause.op)) {
    throw new ValidationError(
      `where: op "${clause.op}" not valid for ${f === VIRTUAL_ID ? "the entry id" : `${f.type} field "${f.name}"`} — allowed: ${ops.join(", ") || "(none)"}`,
    );
  }
  if (clause.op === "in") {
    if (!Array.isArray(clause.value) || clause.value.length === 0) {
      throw new ValidationError(
        `where: op "in" on "${f.name}" needs a non-empty array of values, e.g. {field:"${f.name}",op:"in",value:["a","b"]}`,
      );
    }
  } else if (Array.isArray(clause.value)) {
    throw new ValidationError(
      `where: op "${clause.op}" on "${f.name}" takes a single value, not an array — use op "in" for value lists`,
    );
  }
  // C2: resolve a relative time to an absolute instant BEFORE anything else, so
  // every op below sees an ordinary ISO value. Only dates accept it — on any
  // other type it is a mistake, and silently stringifying "[object Object]"
  // would match nothing while looking like a working filter.
  if (isRelativeTime(clause.value)) {
    if (f.type !== "date") {
      throw new ValidationError(
        `where: a relative time ({daysAgo}/{hoursAgo}) is only valid on a date field — "${f.name}" is ${f.type}`,
      );
    }
    clause = { ...clause, value: resolveRelativeTime(clause.value) };
  }

  // A3: for an indexed date every comparison value is canonicalized to the
  // stored form, so the text index applies and the answer is identical to the
  // ::timestamptz path.
  const rhs = (v: unknown): string => (isIndexedDate(f) ? canonicalDateValue(f, v) : String(v));

  switch (clause.op) {
    case "eq":
      if (f.type === "boolean") return sql`${lhs} = ${Boolean(clause.value)}`;
      if (f.type === "number") return sql`${lhs} = ${Number(clause.value)}`;
      return sql`${lhs} = ${rhs(clause.value)}`;
    case "ne":
      // SET AND different — an unset field never matches (SQL != excludes
      // NULL; fail-closed for publicFilter). "different OR unset" composes as
      // anyOf: [{ne}, {exists:false}].
      if (f.type === "boolean") return sql`${lhs} != ${Boolean(clause.value)}`;
      if (f.type === "number") return sql`${lhs} != ${Number(clause.value)}`;
      return sql`${lhs} != ${rhs(clause.value)}`;
    case "neOrUnset": {
      // "different OR not set" — the exclusion idiom. `ne` alone is fail-closed
      // (an unset field never matches), which is right for publicFilter but
      // means every flag-exclusion query needs anyOf:[{ne},{exists:false}].
      // A reporter hit this on email_opt_out compliance filtering, where
      // forgetting the second clause silently INCLUDES rows you must exclude —
      // a wrong answer that looks like a working query.
      const probe = sql`${entries.data}->>${f.name}`;
      const neq =
        f.type === "boolean"
          ? sql`${lhs} != ${Boolean(clause.value)}`
          : f.type === "number"
            ? sql`${lhs} != ${Number(clause.value)}`
            : sql`${lhs} != ${rhs(clause.value)}`;
      return sql`(${neq} OR ${probe} IS NULL)`;
    }
    case "exists": {
      if (typeof clause.value !== "boolean") {
        throw new ValidationError(`where: op "exists" takes true or false (field "${f.name}")`);
      }
      // Presence = key present AND not JSON null — the raw ->> text probe
      // (uncasted, so a malformed legacy value can never throw here).
      const probe = sql`${entries.data}->>${f.name}`;
      return clause.value ? sql`${probe} IS NOT NULL` : sql`${probe} IS NULL`;
    }
    case "contains": {
      // F4: treat the needle as a literal — escape LIKE metacharacters so `%`/`_`
      // in user input match themselves, not as wildcards. matchesClauses() uses a
      // literal JS includes(), so this also aligns SQL with in-memory contains.
      const needle = String(clause.value).replace(/[\\%_]/g, "\\$&");
      return sql`${lhs} ILIKE ${"%" + needle + "%"} ESCAPE '\\'`;
    }
    case "gt":
      if (f.type === "number") return sql`${lhs} > ${Number(clause.value)}`;
      // A3: no ::timestamptz on the indexed path — that cast is exactly what
      // would stop the planner using the text index.
      return isIndexedDate(f)
        ? sql`${lhs} > ${rhs(clause.value)}`
        : sql`${lhs} > ${String(clause.value)}::timestamptz`;
    case "lt":
      if (f.type === "number") return sql`${lhs} < ${Number(clause.value)}`;
      return isIndexedDate(f)
        ? sql`${lhs} < ${rhs(clause.value)}`
        : sql`${lhs} < ${String(clause.value)}::timestamptz`;
    case "in": {
      const values = (clause.value as string[]).map((v) => sql`${String(v)}`);
      return sql`${lhs} IN (${sql.join(values, sql`, `)})`;
    }
    case "has": {
      // JSONB containment: `["a","b"] @> ["a"]`. Coerced to the ITEM's type so
      // a numeric tag does not silently miss (JSON 1 !== "1"), and expressed as
      // @> specifically because that is the operator a GIN index can serve.
      const item = (f as { item?: { type?: string } }).item;
      const v = clause.value;
      const coerced =
        item?.type === "number" ? Number(v) : item?.type === "boolean" ? Boolean(v) : String(v);
      if (item?.type === "number" && Number.isNaN(coerced as number)) {
        throw new ValidationError(`where: op "has" on "${f.name}" needs a number — got ${JSON.stringify(v)}`);
      }
      return sql`${lhs} @> ${JSON.stringify([coerced])}::jsonb`;
    }
  }
}

/**
 * Compile a `relationField.targetField` clause to an EXISTS over the target
 * (aliased) — depth 1 only. The whole predicate is schema-validated: head must
 * be a relation field, tail a real field on the target, op within the target
 * field's type ops ∩ the surface policy. The context's gateClauses (delivery:
 * the target's publicFilter) are ANDed INSIDE the EXISTS, with NO related
 * context of their own, so a nested dotted field throws (recursion safety).
 */
function compileRelatedClause(
  fields: FieldDef[],
  clause: WhereClause,
  related: RelatedContextMap | undefined,
): SQL {
  const dot = clause.field.indexOf(".");
  const head = clause.field.slice(0, dot);
  const tail = clause.field.slice(dot + 1);
  if (tail.includes(".")) {
    throw new ValidationError(
      `where: "${clause.field}" — only one relation hop is supported (relationField.targetField)`,
    );
  }
  const headField = fields.find((x) => x.name === head);
  if (!headField || headField.type !== "relation") {
    throw new ValidationError(
      `where: "${head}" is not a relation field — a "head.tail" filter needs a relation field before the dot`,
    );
  }
  if (!related) {
    throw new ValidationError(
      `where: related-field clauses (relationField.targetField) are only valid in query where — not publicFilter, events.when, or update_entry_if.if`,
    );
  }
  const ctx = related.get(head);
  if (!ctx) {
    throw new ValidationError(`where: "${head}" cannot be used for related filtering on this surface`);
  }
  // The tail is resolved against the TARGET's fields, which is a second lookup
  // path that never passes through fieldOrThrow — so the localized/write-only
  // gates have to be re-applied here or `user.password_hash eq "…"` would
  // compile on the MCP surface (queryFields = every target field).
  const tailField = ctx.queryFields.find((x) => x.name === tail);
  if (!tailField) {
    throw new ValidationError(
      `where: "${tail}" is not a filterable field on the target of "${head}" — options: ${ctx.queryFields.map((x) => x.name).join(", ")}`,
    );
  }
  if (fieldWriteOnly(tailField) || fieldLocalized(tailField)) {
    throw new ValidationError(
      `where: "${clause.field}" — "${tail}" on the target of "${head}" is a ${
        fieldWriteOnly(tailField) ? "write-only" : "localized"
      } field and cannot be filtered`,
    );
  }
  const aliasName = `rel_${head}`;
  const t = alias(entries, aliasName);
  const tailCond = compileScalarClause(tailField, clause, accessor(tailField, t.data), ctx.allowedOps);
  // Gate clauses (delivery: target publicFilter) compiled against the alias, no
  // related context — a nested dotted field inside them throws.
  const gates = ctx.gateClauses.map((item) => compileOn(ctx.gateFields, item, t.data));
  const conds = [
    sql`${t.id}::text = ${accessor(headField)}`,
    sql`${t.collectionId} = ${ctx.collectionId}`,
    tailCond,
    ...gates,
  ];
  // Raw sql interpolation of an aliased table renders only its alias name, so
  // spell out "entries" AS <alias> explicitly for the FROM.
  return sql`EXISTS (SELECT 1 FROM ${entries} ${sql.identifier(aliasName)} WHERE ${and(...conds)})`;
}

/** Compile one where item against an explicit data column (for EXISTS gates). */
function compileOn(fields: FieldDef[], item: WhereItem, dataCol: AnyColumn | SQL): SQL {
  if ("anyOf" in item) {
    const conds = item.anyOf.map((c) => compileScalarClauseOn(fields, c, dataCol));
    return conds.length === 1 ? conds[0] : sql`(${sql.join(conds, sql` OR `)})`;
  }
  return compileScalarClauseOn(fields, item, dataCol);
}

function compileScalarClauseOn(fields: FieldDef[], clause: WhereClause, dataCol: AnyColumn | SQL): SQL {
  if (clause.field.includes(".")) {
    throw new ValidationError("where: nested related fields are not allowed inside a related filter's gate");
  }
  const f = fieldOrThrow(fields, clause.field, "where");
  return compileScalarClause(f, clause, accessor(f, dataCol));
}

function compileClause(
  fields: FieldDef[],
  clause: WhereClause,
  related?: RelatedContextMap,
): SQL {
  if (clause.field.includes(".")) {
    return compileRelatedClause(fields, clause, related);
  }
  const f = fieldOrThrow(fields, clause.field, "where");
  return compileScalarClause(f, clause, accessor(f));
}

/** JS-side item evaluation for single-entry row gates (same semantics as buildWhere). */
/**
 * Human/agent-readable rendering of a clause list — used when a gate REFUSES,
 * so the message names the actual requirement instead of "condition not met".
 * A precondition the caller cannot see is one they cannot satisfy.
 */
export function describeClauses(items: WhereItem[]): string {
  const one = (c: WhereClause): string => {
    if (c.op === "exists") return c.value === false ? `${c.field} to be unset` : `${c.field} to be set`;
    if (c.op === "has") return `${c.field} to contain ${JSON.stringify(c.value)}`;
    const verb =
      c.op === "eq" ? "=" : c.op === "ne" ? "!=" : c.op === "neOrUnset" ? "!= (or unset)" :
      c.op === "gt" ? ">" : c.op === "lt" ? "<" : c.op === "in" ? "in" : c.op;
    return `${c.field} ${verb} ${JSON.stringify(c.value)}`;
  };
  return items
    .map((i) => ("anyOf" in i ? `(${i.anyOf.map(one).join(" or ")})` : one(i)))
    .join(" and ");
}

export function matchesClauses(
  fields: FieldDef[],
  clauses: WhereItem[],
  data: Record<string, unknown>,
): boolean {
  return clauses.every((item) =>
    "anyOf" in item
      ? item.anyOf.some((c) => matchClause(fields, c, data))
      : matchClause(fields, item, data),
  );
}

function matchClause(
  fields: FieldDef[],
  c: WhereClause,
  data: Record<string, unknown>,
): boolean {
  {
    const f = fields.find((x) => x.name === c.field);
    if (!f) return false;
    // SEC-1: unreachable via a validated schema (fieldOrThrow refuses such a
    // clause at define time), so this is the fail-closed floor rather than a
    // second implementation of the rule: never MATCH on a write-only field.
    // Every caller treats false as "hidden"/"don't fire".
    if (fieldWriteOnly(f)) return false;
    // C2: resolve here too. A divergence would make a window match in list
    // queries (SQL) and fail single-entry gates (JS) — the same class of bug
    // the neOrUnset pair is tested against.
    if (isRelativeTime(c.value)) {
      if (f.type !== "date") return false;
      c = { ...c, value: resolveRelativeTime(c.value) };
    }
    const v = data[c.field];
    switch (c.op) {
      case "in":
        return Array.isArray(c.value) && c.value.some((x) => String(v ?? "") === String(x));
      case "ne": {
        // Mirror SQL exactly: unset never matches (fail-closed).
        if (v == null) return false;
        if (f.type === "number") return Number(v) !== Number(c.value);
        if (f.type === "boolean") return Boolean(v) !== Boolean(c.value);
        if (f.type === "date") return Date.parse(String(v)) !== Date.parse(String(c.value));
        return String(v) !== String(c.value);
      }
      case "neOrUnset": {
        // Same as `ne` except an unset field MATCHES. Must mirror the SQL above
        // exactly — a divergence here would make a clause match in list queries
        // (SQL) but fail single-entry gates (JS), which is the worst kind of bug
        // to chase.
        if (v == null) return true;
        if (f.type === "number") return Number(v) !== Number(c.value);
        if (f.type === "boolean") return Boolean(v) !== Boolean(c.value);
        if (f.type === "date") return Date.parse(String(v)) !== Date.parse(String(c.value));
        return String(v) !== String(c.value);
      }
      case "has": {
        // Mirrors the SQL containment exactly, including the item-type coercion.
        if (!Array.isArray(v)) return false;
        const item = (f as { item?: { type?: string } }).item;
        return item?.type === "number"
          ? v.some((x) => Number(x) === Number(c.value))
          : item?.type === "boolean"
            ? v.some((x) => Boolean(x) === Boolean(c.value))
            : v.some((x) => String(x) === String(c.value));
      }
      case "exists":
        return (v != null) === Boolean(c.value);
      case "eq":
        if (f.type === "number") return Number(v) === Number(c.value);
        if (f.type === "boolean") return Boolean(v) === Boolean(c.value);
        // Dates compare as instants, mirroring the SQL ::timestamptz cast —
        // otherwise a clause written in a non-UTC offset matches list queries
        // (SQL) but fails single-entry gates (JS). NaN never matches.
        if (f.type === "date") return Date.parse(String(v ?? "")) === Date.parse(String(c.value));
        return String(v ?? "") === String(c.value);
      case "contains":
        return String(v ?? "").toLowerCase().includes(String(c.value).toLowerCase());
      case "gt":
        return f.type === "number"
          ? Number(v) > Number(c.value)
          : new Date(String(v)) > new Date(String(c.value));
      case "lt":
        return f.type === "number"
          ? Number(v) < Number(c.value)
          : new Date(String(v)) < new Date(String(c.value));
    }
  }
}

/** Validate + compile an orderBy clause. Throws ValidationError. */
export function buildOrderBy(fields: FieldDef[], orderBy?: OrderByClause): SQL | undefined {
  if (!orderBy) return undefined;
  const f = fieldOrThrow(fields, orderBy.field, "orderBy");
  // C1: a set has no order. Arrays became FILTERABLE (`has`), which makes
  // sorting by one the obvious next thing to try — and it would not have
  // errored, it would have ordered rows by the raw JSONB, which is a
  // meaningless result presented as a real one.
  if (f.type === "array" || f.type === "group") {
    throw new ValidationError(
      `orderBy: "${f.name}" is a ${f.type} field and cannot be sorted — ${
        f.type === "array" ? "a set has no order; filter it with op \"has\" instead" : "sort by one of its sub-fields' own columns"
      }`,
    );
  }
  if (orderBy.dir !== "asc" && orderBy.dir !== "desc") {
    throw new ValidationError(`orderBy: dir must be "asc" or "desc"`);
  }
  const lhs = accessor(f);
  // dir is validated above, so sql.raw is safe here.
  return sql`${lhs} ${sql.raw(orderBy.dir)} NULLS LAST`;
}
