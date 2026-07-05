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

export const WHERE_OPS = ["eq", "contains", "gt", "lt"] as const;
export type WhereOp = (typeof WHERE_OPS)[number];

export interface WhereClause {
  field: string;
  op: WhereOp;
  value: string | number | boolean;
}

export interface OrderByClause {
  field: string;
  dir: "asc" | "desc";
}

/** Which operators make sense per primitive. */
const OPS_BY_TYPE: Record<FieldDef["type"], WhereOp[]> = {
  text: ["eq", "contains"],
  richtext: ["contains"],
  number: ["eq", "gt", "lt"],
  boolean: ["eq"],
  date: ["eq", "gt", "lt"],
  enum: ["eq"],
  asset: ["eq"],
  relation: ["eq"],
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
function accessor(field: FieldDef): SQL {
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

/** Validate + compile where clauses to SQL conditions. Throws ValidationError. */
export function buildWhere(fields: FieldDef[], where: WhereClause[]): SQL[] {
  return where.map((clause) => {
    const f = fieldOrThrow(fields, clause.field, "where");
    if (!OPS_BY_TYPE[f.type].includes(clause.op)) {
      throw new ValidationError(
        `where: op "${clause.op}" not valid for ${f.type} field "${f.name}" — allowed: ${OPS_BY_TYPE[f.type].join(", ")}`,
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
    }
  });
}

/** JS-side clause evaluation for single-entry row gates (same semantics as buildWhere). */
export function matchesClauses(
  fields: FieldDef[],
  clauses: WhereClause[],
  data: Record<string, unknown>,
): boolean {
  return clauses.every((c) => {
    const f = fields.find((x) => x.name === c.field);
    if (!f) return false;
    const v = data[c.field];
    switch (c.op) {
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
  });
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
