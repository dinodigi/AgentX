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

/** True if any computed field recomputes on update (so updateEntry must fetch
 * the current row). uuid and now(on:'create') stay frozen. */
export function hasRecomputable(fields: FieldDef[]): boolean {
  return fields.some(
    (f) =>
      f.computed &&
      (f.computed.fn === "slugify" ||
        f.computed.fn === "template" ||
        (f.computed.fn === "now" && f.computed.on === "always")),
  );
}

/**
 * I4: recompute source-triggered computed fields on update. slugify/template
 * recompute only when a source field is in the patch; now(on:'always') restamps
 * every update; uuid + now(on:'create') stay frozen. Returns the additions to
 * merge into the patch (computed over the MERGED post-patch snapshot).
 */
export function recomputeOnUpdate(
  fields: FieldDef[],
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const patchKeys = new Set(Object.keys(patch));
  const merged = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const additions: Record<string, unknown> = {};
  for (const f of fields) {
    const c = f.computed;
    if (!c) continue;
    const recompute =
      c.fn === "slugify"
        ? patchKeys.has(c.from)
        : c.fn === "template"
          ? [...c.template.matchAll(/\{\{(\w+)\}\}/g)].some((m) => patchKeys.has(m[1]))
          : c.fn === "now"
            ? c.on === "always"
            : false; // uuid, now(on:'create')
    if (recompute) additions[f.name] = computeValue(c, merged);
  }
  return additions;
}
