import { sql, type SQL } from "drizzle-orm";
import { entries } from "@/db/schema";
import type { FieldDef } from "./field-types";
import { ValidationError } from "./validation";

/**
 * Schema-validated filtering + sorting over JSONB entry data. Every clause is
 * checked against the collection's field defs before any SQL is built, so an
 * agent (or the public API) can never filter/sort on a field that doesn't
 * exist, use an operator that doesn't fit the type, or inject anything.
 */

export const WHERE_OPS = ["eq", "contains", "gt", "lt", "in"] as const;
export type WhereOp = (typeof WHERE_OPS)[number];

export interface WhereClause {
  field: string;
  op: WhereOp;
  /** `in` takes a string[]; every other op takes a scalar. */
  value: string | number | boolean | string[];
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
  text: ["eq", "contains", "in"],
  richtext: ["contains"],
  number: ["eq", "gt", "lt"],
  boolean: ["eq"],
  date: ["eq", "gt", "lt"],
  enum: ["eq", "in"],
  asset: ["eq"],
  relation: ["eq", "in"],
};

function fieldOrThrow(fields: FieldDef[], name: string, context: string): FieldDef {
  const f = fields.find((x) => x.name === name);
  if (!f) {
    throw new ValidationError(
      `${context}: unknown field "${name}" — valid fields: ${fields.map((x) => x.name).join(", ")}`,
    );
  }
  return f;
}

/** JSONB text accessor for a field, cast per type where needed. */
export function accessor(field: FieldDef): SQL {
  const raw = sql`${entries.data}->>${field.name}`;
  switch (field.type) {
    case "number":
      return sql`(${raw})::numeric`;
    case "date":
      return sql`(${raw})::timestamptz`;
    case "boolean":
      return sql`(${raw})::boolean`;
    default:
      return raw;
  }
}

/** Validate + compile where items (clauses + OR groups) to SQL conditions. Throws ValidationError. */
export function buildWhere(fields: FieldDef[], where: WhereItem[]): SQL[] {
  return where.map((item) => {
    if ("anyOf" in item) {
      if (!Array.isArray(item.anyOf) || item.anyOf.length === 0) {
        throw new ValidationError("where: anyOf needs a non-empty array of clauses");
      }
      const conds = item.anyOf.map((c) => {
        if (typeof c !== "object" || c === null || "anyOf" in c) {
          throw new ValidationError("where: anyOf cannot nest another anyOf — one level only");
        }
        return compileClause(fields, c);
      });
      return conds.length === 1 ? conds[0] : sql`(${sql.join(conds, sql` OR `)})`;
    }
    return compileClause(fields, item);
  });
}

function compileClause(fields: FieldDef[], clause: WhereClause): SQL {
  const f = fieldOrThrow(fields, clause.field, "where");
  if (!OPS_BY_TYPE[f.type].includes(clause.op)) {
    throw new ValidationError(
      `where: op "${clause.op}" not valid for ${f.type} field "${f.name}" — allowed: ${OPS_BY_TYPE[f.type].join(", ")}`,
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
  const lhs = accessor(f);
  switch (clause.op) {
    case "eq":
      if (f.type === "boolean") return sql`${lhs} = ${Boolean(clause.value)}`;
      if (f.type === "number") return sql`${lhs} = ${Number(clause.value)}`;
      return sql`${lhs} = ${String(clause.value)}`;
    case "contains":
      return sql`${lhs} ILIKE ${"%" + String(clause.value) + "%"}`;
    case "gt":
      return f.type === "number"
        ? sql`${lhs} > ${Number(clause.value)}`
        : sql`${lhs} > ${String(clause.value)}::timestamptz`;
    case "lt":
      return f.type === "number"
        ? sql`${lhs} < ${Number(clause.value)}`
        : sql`${lhs} < ${String(clause.value)}::timestamptz`;
    case "in": {
      const values = (clause.value as string[]).map((v) => sql`${String(v)}`);
      return sql`${lhs} IN (${sql.join(values, sql`, `)})`;
    }
  }
}

/** JS-side item evaluation for single-entry row gates (same semantics as buildWhere). */
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
    const v = data[c.field];
    switch (c.op) {
      case "in":
        return Array.isArray(c.value) && c.value.some((x) => String(v ?? "") === String(x));
      case "eq":
        if (f.type === "number") return Number(v) === Number(c.value);
        if (f.type === "boolean") return Boolean(v) === Boolean(c.value);
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
  if (orderBy.dir !== "asc" && orderBy.dir !== "desc") {
    throw new ValidationError(`orderBy: dir must be "asc" or "desc"`);
  }
  const lhs = accessor(f);
  // dir is validated above, so sql.raw is safe here.
  return sql`${lhs} ${sql.raw(orderBy.dir)} NULLS LAST`;
}
