import { randomUUID } from "node:crypto";
import type { FieldDef, ComputedSpec } from "./field-types";

/**
 * I3: computed fields — a CLOSED vocabulary evaluated platform-side (no
 * expression language, ever). Stamped in the entries write core AFTER the
 * candidate (and any hook transform) is validated, so the output still obeys
 * min/max and unique indexes. Client-supplied computed keys are rejected by the
 * schema's INPUT mode; here we produce the server value.
 */

/** lowercase → NFD strip diacritics → non-alnum to '-' → collapse/trim. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** {{field}} interpolation over sibling values — the same idiom as event actions. */
function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(data[key] ?? ""));
}

function computeValue(c: ComputedSpec, data: Record<string, unknown>): string {
  switch (c.fn) {
    case "slugify":
      return slugify(String(data[c.from] ?? ""));
    case "template":
      return interpolate(c.template, data);
    case "now":
      return new Date().toISOString();
    case "uuid":
      return randomUUID();
  }
}

/** Stamp every computed field's value into a COPY of `data` (create-time; I4
 * adds selective recompute on update). Templates/slugify read sibling values,
 * which are already validated, so ordering within one pass is deterministic. */
export function evaluateComputed(fields: FieldDef[], data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const f of fields) {
    if (f.computed) out[f.name] = computeValue(f.computed, out);
  }
  return out;
}

/** Names of the computed fields — used to reject client-supplied values. */
export function computedFieldNames(fields: FieldDef[]): Set<string> {
  return new Set(fields.filter((f) => f.computed).map((f) => f.name));
}
