import { z } from "zod";
import {
  FIELD_TYPES,
  fieldMin,
  fieldMax,
  fieldPattern,
  fieldLocalized,
  MAX_ARRAY_ITEMS,
  MAX_CONTAINER_DEPTH,
  MAX_ARRAY_GROUP_DEPTH,
  MAX_ENTRY_NODES,
  MAX_BLOCK_TYPES,
  type FieldDef,
} from "./field-types";
import type { ProjectLocales } from "@/db/schema";
import type { ErrorCode } from "./error-codes";

/**
 * The validation core — the single guard that keeps an AI (or a public form)
 * from corrupting stored data. Two layers:
 *
 *  1. META-SCHEMA (`fieldDefSchema`): validates a collection's *definition*
 *     before it is ever stored. Rejects malformed field defs in define_collection.
 *
 *  2. RUNTIME COMPILER (`buildEntrySchema`): turns a stored collection's fields[]
 *     into a strict Zod object schema for create/update. Unknown keys are
 *     rejected, types are not silently coerced, enums are constrained to their
 *     options, required is enforced.
 *
 * Relation *existence* (does the referenced id exist in the target collection?)
 * can't be checked with a pure schema — it needs the DB. `collectRelationChecks`
 * surfaces those so the caller can verify them; see lib/entries.ts.
 *
 * Shared by the MCP server, the admin dashboard, and the delivery API so there
 * is exactly one definition of "valid".
 */

const NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * A field with `pattern` must also set max <= this cap. Length bounds the input
 * a regex sees — but for a catastrophic pattern like (a+)+$, cost is exponential
 * in input length, so ~35 chars already hangs the event loop. Length alone is
 * NOT a ReDoS defense; `patternStarHeightSafe` rejecting the dangerous pattern
 * CLASS at define time is what makes runtime `re.test` provably bounded.
 */
const PATTERN_LENGTH_CAP = 10_000;
/** Sanity bound on the pattern source itself (readability, not security). */
const PATTERN_SOURCE_CAP = 200;

/**
 * Reject catastrophic-backtracking patterns (star height > 1): a quantifier
 * applied to a group that itself contains a quantifier — (a+)+, (\w+\s?)+,
 * (a|b+)* etc. This is the safe-regex heuristic. Owner-authored patterns run
 * against attacker-controlled input on public-write forms, so only linear-time
 * patterns may ever enter the registry. (A future RE2/recheck pass could widen
 * coverage to polynomial cases; this closes the demonstrated exponential class.)
 */
export function patternStarHeightSafe(src: string): boolean {
  const stack: { inner: boolean }[] = [{ inner: false }];
  let inClass = false;
  let closedGroupHadInner = false;
  let prevWasGroupClose = false;
  let i = 0;
  const isQ = (c: string) => c === "*" || c === "+" || c === "?" || c === "{";
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; prevWasGroupClose = false; continue; }
    if (inClass) { if (c === "]") inClass = false; i++; prevWasGroupClose = false; continue; }
    if (c === "[") { inClass = true; i++; prevWasGroupClose = false; continue; }
    if (c === "(") {
      stack.push({ inner: false });
      i++;
      // Skip a group-type prefix so its chars aren't read as quantifiers:
      // (?:  (?=  (?!  (?<=  (?<!  (?<name>
      if (src[i] === "?") {
        i++;
        if (src[i] === "<" && src[i + 1] !== "=" && src[i + 1] !== "!") {
          while (i < src.length && src[i] !== ">") i++;
          i++; // consume '>'
        } else {
          if (src[i] === "<") i++; // lookbehind marker
          i++; // consume : = or !
        }
      }
      prevWasGroupClose = false;
      continue;
    }
    if (c === ")") {
      const frame = stack.pop() ?? { inner: false };
      closedGroupHadInner = frame.inner;
      // A group that held a quantifier taints its parent, so an outer quantifier
      // on any ancestor is still caught (conservative star-height).
      if (frame.inner && stack.length) stack[stack.length - 1].inner = true;
      prevWasGroupClose = true;
      i++;
      continue;
    }
    if (isQ(c)) {
      if (prevWasGroupClose && closedGroupHadInner) return false; // star height >= 2
      stack[stack.length - 1].inner = true;
      if (c === "{") { while (i < src.length && src[i] !== "}") i++; }
      prevWasGroupClose = false;
      i++;
      continue;
    }
    prevWasGroupClose = false;
    i++;
  }
  return true;
}

/**
 * One machine-readable violation. `hint` is the human/agent fix text; the
 * discriminated extras (limit/allowed/pattern) let an agent repair without
 * parsing prose. Composed by every error surface (MCP, delivery, and later
 * transact per-op errors and hook rejections).
 */
export type ConstraintKind =
  | "type"
  | "required"
  | "required_if"
  | "min"
  | "max"
  | "pattern"
  | "enum"
  | "unique"
  | "computed"
  | "unknown_field"
  | "ref_missing";

export interface ConstraintIssue {
  field: string;
  constraint: ConstraintKind;
  limit?: number | string;
  allowed?: string[];
  pattern?: string;
  hint: string;
}

/** Thrown for any agent-repairable input problem; message doubles as the fix hint. */
export class ValidationError extends Error {
  readonly code: ErrorCode;
  /** Structured mirror of `message` — present on validation-shaped failures. */
  readonly issues?: ConstraintIssue[];
  constructor(message: string, code: ErrorCode = "E_VALIDATION", issues?: ConstraintIssue[]) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.issues = issues;
  }
}

/**
 * Map a ZodError onto ConstraintIssue[]. `fields` (when the error came from an
 * entry schema) supplies exact limits/options; pass [] for generic zod errors
 * (tool args, definition meta-schema) — the mapping degrades to what the issue
 * itself carries.
 */
export function issuesFromZod(err: z.ZodError, fields: FieldDef[]): ConstraintIssue[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const out: ConstraintIssue[] = [];
  for (const issue of err.issues) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      for (const key of issue.keys) {
        out.push({
          field: key,
          constraint: "unknown_field",
          hint: `unknown field "${key}" — not in the collection schema`,
        });
      }
      continue;
    }
    const field = String(issue.path[0] ?? "(root)");
    const def = byName.get(field);
    const hint = issue.message;
    switch (issue.code) {
      case z.ZodIssueCode.too_small:
        out.push({ field, constraint: "min", limit: (def && fieldMin(def)) ?? Number(issue.minimum), hint });
        break;
      case z.ZodIssueCode.too_big:
        out.push({ field, constraint: "max", limit: (def && fieldMax(def)) ?? Number(issue.maximum), hint });
        break;
      case z.ZodIssueCode.invalid_enum_value:
        out.push({
          field,
          constraint: "enum",
          allowed:
            def?.type === "enum" ? def.options : issue.options?.map((o) => String(o)),
          hint,
        });
        break;
      case z.ZodIssueCode.invalid_type:
        out.push({
          field,
          constraint: issue.received === "undefined" ? "required" : "type",
          hint,
        });
        break;
      case z.ZodIssueCode.custom: {
        const tagged = (issue.params as { constraint?: ConstraintKind } | undefined)?.constraint;
        if (tagged === "pattern") {
          out.push({ field, constraint: "pattern", pattern: def && fieldPattern(def), hint });
        } else if (tagged === "min" || tagged === "max") {
          out.push({ field, constraint: tagged, limit: def && (tagged === "min" ? fieldMin(def) : fieldMax(def)), hint });
        } else if (tagged === "required_if" || tagged === "required") {
          out.push({ field, constraint: tagged, hint });
        } else {
          out.push({ field, constraint: "type", hint });
        }
        break;
      }
      default:
        out.push({ field, constraint: "type", hint });
    }
  }
  return out;
}

/** One array element's shape: a scalar leaf (nameless) or a repeated group. */
const arrayItemSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("text"), min: z.number().optional(), max: z.number().optional(), pattern: z.string().optional(), patternHint: z.string().optional() }).strict(),
    z.object({ type: z.literal("richtext"), min: z.number().optional(), max: z.number().optional() }).strict(),
    z.object({ type: z.literal("number"), min: z.number().optional(), max: z.number().optional(), integer: z.boolean().optional() }).strict(),
    z.object({ type: z.literal("boolean") }).strict(),
    z.object({ type: z.literal("date"), min: z.string().optional(), max: z.string().optional() }).strict(),
    z.object({ type: z.literal("enum"), options: z.array(z.string().min(1)).min(1) }).strict(),
    z.object({ type: z.literal("asset") }).strict(),
    z.object({ type: z.literal("group"), fields: z.array(fieldDefSchema).min(1) }).strict(),
  ]),
);

/** One typed block: a named, labeled group of fields (`_type` discriminator). */
const blockDefSchema: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      name: z.string().min(1).regex(NAME_RE, "block name must be snake_case starting with a letter"),
      label: z.string().min(1),
      fields: z.array(fieldDefSchema).min(1),
    })
    .strict(),
);

/** Meta-schema: the shape of a single field definition. */
const fieldDefSchema: z.ZodTypeAny = z.lazy(() =>
  z
  .object({
    name: z
      .string()
      .min(1)
      .regex(NAME_RE, "field name must be snake_case starting with a letter"),
    label: z.string().min(1),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    publicRead: z.boolean().optional(),
    indexed: z.boolean().optional(),
    // constraints (subsystem 05), validated per type by superRefine below
    unique: z.boolean().optional(),
    min: z.union([z.number(), z.string()]).optional(),
    max: z.union([z.number(), z.string()]).optional(),
    integer: z.boolean().optional(),
    requiredIf: z.object({ field: z.string(), equals: z.string() }).strict().optional(),
    pattern: z.string().optional(),
    patternHint: z.string().optional(),
    searchable: z.boolean().optional(),
    localized: z.boolean().optional(),
    writableBy: z
      .union([
        z.literal("none"),
        z
          .object({ claim: z.string().min(1), equals: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) })
          .strict(),
      ])
      .optional(),
    // type-specific, validated by superRefine below
    options: z.array(z.string().min(1)).optional(),
    targetCollection: z.string().regex(NAME_RE).optional(),
    labelField: z.string().regex(NAME_RE).optional(),
    computed: z
      .union([
        z.object({ fn: z.literal("slugify"), from: z.string().min(1) }).strict(),
        z.object({ fn: z.literal("template"), template: z.string().min(1) }).strict(),
        z.object({ fn: z.literal("now"), on: z.enum(["create", "always"]).optional() }).strict(),
        z.object({ fn: z.literal("uuid") }).strict(),
      ])
      .optional(),
    // Structured fields (group/array). Validated recursively here + by
    // walkStructure() below (depth / nesting / forbidden-nested rules).
    fields: z.array(fieldDefSchema).optional(),
    item: arrayItemSchema.optional(),
    blocks: z.array(blockDefSchema).min(1).optional(),
    maxItems: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    // J5: localized = a {locale: value} variant map on text/richtext. Barred
    // from every knob that needs ONE comparable/indexable/printable value.
    if (f.localized) {
      if (f.type !== "text" && f.type !== "richtext") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "localized is only valid on text/richtext fields",
        });
      }
      if (f.unique) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a localized field cannot be unique — a variant map has no single comparable value",
        });
      }
      if (f.searchable) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "a localized field cannot be searchable — search is not locale-aware yet; make a non-localized field searchable instead",
        });
      }
      if (f.computed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a computed field cannot be localized — computed values are derived single strings",
        });
      }
    }
    if (f.computed) {
      const fn = f.computed.fn;
      if ((fn === "slugify" || fn === "template" || fn === "uuid") && f.type !== "text") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `computed ${fn} is only valid on a text field` });
      }
      if (fn === "now" && f.type !== "date") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "computed now is only valid on a date field" });
      }
      if (f.required || f.requiredIf) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a computed field can't be required/requiredIf — its value is always derived server-side",
        });
      }
    }
    if (f.type === "enum" && (!f.options || f.options.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enum fields require a non-empty options[]" });
    }
    if (f.type !== "enum" && f.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "options[] is only valid on enum fields" });
    }
    if (f.type === "relation" && (!f.targetCollection || !f.labelField)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "relation fields require targetCollection and labelField",
      });
    }
    if (f.type !== "relation" && (f.targetCollection || f.labelField)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "targetCollection/labelField are only valid on relation fields",
      });
    }
    if (f.unique && !["text", "number", "date"].includes(f.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unique is only valid on text/number/date fields",
      });
    }
    if (
      (f.min !== undefined || f.max !== undefined) &&
      !["text", "richtext", "number", "date"].includes(f.type)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "min/max are only valid on text/richtext (length), number (value), and date (ISO value) fields",
      });
    }
    if (f.type === "date") {
      for (const [knob, v] of [["min", f.min], ["max", f.max]] as const) {
        if (v !== undefined && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `date ${knob} must be a parseable ISO date string`,
          });
        }
      }
    } else if (["text", "richtext", "number"].includes(f.type)) {
      if (
        (f.min !== undefined && typeof f.min !== "number") ||
        (f.max !== undefined && typeof f.max !== "number")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `min/max must be numbers on ${f.type} fields (ISO strings are for date fields)`,
        });
      }
    }
    if (f.min !== undefined && f.max !== undefined && typeof f.min === typeof f.max) {
      const inverted =
        typeof f.min === "number"
          ? f.min > (f.max as number)
          : Date.parse(f.min as string) > Date.parse(f.max as string);
      if (inverted) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "min must be <= max" });
      }
    }
    if (f.integer && f.type !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "integer is only valid on number fields" });
    }
    if (f.searchable && f.type !== "text" && f.type !== "richtext") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "searchable is only valid on text/richtext fields",
      });
    }
    if (f.indexed && (f.type === "richtext" || f.type === "group" || f.type === "array")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          f.type === "richtext"
            ? "indexed is not valid on richtext — use searchable for full-text"
            : "indexed is not valid on group/array — nested content isn't filterable/sortable",
      });
    }
    if (f.pattern !== undefined) {
      if (f.type !== "text") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pattern is only valid on text fields" });
      }
      if (f.pattern.length > PATTERN_SOURCE_CAP) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pattern source must be <= ${PATTERN_SOURCE_CAP} characters`,
        });
      }
      try {
        new RegExp(f.pattern);
        if (!patternStarHeightSafe(f.pattern)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "pattern has nested quantifiers (e.g. (a+)+ ) which risk catastrophic " +
              "backtracking — rewrite so no quantifier is applied to a group that already " +
              "contains one",
          });
        }
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pattern is not a valid JS regular expression: ${(e as Error).message}`,
        });
      }
      if (typeof f.max !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pattern requires a max length so validation cost is bounded — set max (<= ${PATTERN_LENGTH_CAP})`,
        });
      } else if (f.max > PATTERN_LENGTH_CAP) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `with pattern, max must be <= ${PATTERN_LENGTH_CAP}`,
        });
      }
    }
    if (f.patternHint !== undefined && f.pattern === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "patternHint is only valid alongside pattern" });
    }
    // Structured fields: presence rules. (min/max/options/unique/pattern/etc. on a
    // group/array are already rejected by the type-list checks above.)
    if (f.type === "group") {
      if (!Array.isArray(f.fields) || f.fields.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a group field needs a non-empty fields[]" });
      }
    } else if (f.type === "array") {
      // Exactly ONE of item (uniform repeater) | blocks (typed blocks).
      if ((f.item === undefined) === (f.blocks === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "an array field needs exactly one of item (uniform repeater) or blocks (typed blocks)",
        });
      }
      if (typeof f.maxItems === "number" && f.maxItems > MAX_ARRAY_ITEMS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `array maxItems must be <= ${MAX_ARRAY_ITEMS}` });
      }
      if (f.blocks !== undefined) {
        if (f.blocks.length > MAX_BLOCK_TYPES) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${MAX_BLOCK_TYPES} block types per array` });
        }
        const names = new Set<string>();
        for (const b of f.blocks as { name: string }[]) {
          if (names.has(b.name)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate block name: ${b.name}` });
          }
          names.add(b.name);
        }
      }
    }
    if (f.type !== "group" && f.fields !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fields[] is only valid on a group field" });
    }
    if (f.type !== "array" && (f.item !== undefined || f.maxItems !== undefined || f.blocks !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "item/blocks/maxItems are only valid on an array field" });
    }
  }),
);

const MAX_STRUCTURED_FIELD_DEFS = 300;

type NestedNode = {
  type: string;
  name?: string;
  fields?: NestedNode[];
  item?: { type: string; fields?: NestedNode[] };
  blocks?: { name?: string; fields?: NestedNode[] }[];
  computed?: unknown;
  localized?: unknown;
  unique?: unknown;
  searchable?: unknown;
  requiredIf?: unknown;
};

/** v1 restrictions on a field nested INSIDE a group/array (deferred, not gaps). */
function assertNestedAllowed(f: NestedNode, ctx: z.RefinementCtx, path: string): void {
  // v1.1 (Track 1a): relation is now ALLOWED nested — a block/group can point
  // at a collection (the "repeating cards → related collection" pattern the
  // one-level rule prescribes). The rest stay banned: their machinery
  // (indexes, variant maps, cross-field rules) doesn't recurse.
  const banned: [string, unknown][] = [
    ["computed", f.computed],
    ["localized", f.localized],
    ["unique", f.unique],
    ["searchable", f.searchable],
    ["requiredIf", f.requiredIf],
  ];
  for (const [name, v] of banned) {
    if (v !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${path}: ${name} not supported inside a group/array yet`,
      });
    }
  }
}

/**
 * Walk a group/array subtree enforcing the position-dependent rules a per-field
 * check can't see: total container depth, repeater-in-repeater depth (array-of-
 * group), and a def-node ceiling. These are the D4-style structural bounds.
 */
function walkStructure(
  node: NestedNode,
  ctx: z.RefinementCtx,
  path: string,
  depth: number,
  arrGroupDepth: number,
  counter: { n: number },
): void {
  if (++counter.n > MAX_STRUCTURED_FIELD_DEFS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `schema has too many nested field defs (> ${MAX_STRUCTURED_FIELD_DEFS})` });
    return;
  }
  if (depth > MAX_CONTAINER_DEPTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${path}: nesting too deep (> ${MAX_CONTAINER_DEPTH} levels)` });
    return;
  }
  if (node.type === "group") {
    for (const sub of node.fields ?? []) {
      assertNestedAllowed(sub, ctx, `${path}.${sub.name}`);
      walkStructure(sub, ctx, `${path}.${sub.name}`, depth + 1, arrGroupDepth, counter);
    }
  } else if (node.type === "array") {
    // Typed blocks: each block is a repeated group shape — the one-level rule
    // applies exactly as for array-of-group (a block may not contain another
    // repeater-of-groups or blocks).
    if (node.blocks) {
      const nextArrGroup = arrGroupDepth + 1;
      if (nextArrGroup > MAX_ARRAY_GROUP_DEPTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${path}: blocks inside a repeater are too deep (> ${MAX_ARRAY_GROUP_DEPTH}) — model the inner list as a related collection instead`,
        });
        return;
      }
      for (const block of node.blocks) {
        const seen = new Set<string>();
        for (const sub of block.fields ?? []) {
          const subPath = `${path}[${block.name}].${sub.name}`;
          if (sub.name === "_type") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${subPath}: "_type" is reserved — it stores the block's discriminator`,
            });
          }
          if (sub.name && seen.has(sub.name)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${subPath}: duplicate field name in block` });
          }
          if (sub.name) seen.add(sub.name);
          assertNestedAllowed(sub, ctx, subPath);
          walkStructure(sub, ctx, subPath, depth + 1, nextArrGroup, counter);
        }
      }
      return;
    }
    const item = node.item;
    if (!item) return;
    const isGroup = item.type === "group";
    const nextArrGroup = arrGroupDepth + (isGroup ? 1 : 0);
    if (nextArrGroup > MAX_ARRAY_GROUP_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${path}: repeater-in-repeater too deep (> ${MAX_ARRAY_GROUP_DEPTH}) — model the inner list as a related collection instead`,
      });
      return;
    }
    if (isGroup) {
      for (const sub of item.fields ?? []) {
        assertNestedAllowed(sub, ctx, `${path}[].${sub.name}`);
        walkStructure(sub, ctx, `${path}[].${sub.name}`, depth + 1, nextArrGroup, counter);
      }
    }
  }
}

/** Meta-schema: a full fields[] array with no duplicate names. */
export const fieldsSchema = z
  .array(fieldDefSchema)
  .min(1, "a collection needs at least one field")
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate field name: ${f.name}` });
      }
      seen.add(f.name);
    }
    // requiredIf must point at a sibling enum field and one of its options.
    for (const f of fields) {
      if (!f.requiredIf) continue;
      const target = fields.find((x) => x.name === f.requiredIf!.field);
      if (!target || target.type !== "enum" || f.requiredIf.field === f.name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${f.name}.requiredIf.field must name a sibling enum field`,
        });
      } else if (!target.options?.includes(f.requiredIf.equals)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${f.name}.requiredIf.equals "${f.requiredIf.equals}" is not an option of "${target.name}" (${target.options?.join(", ")})`,
        });
      }
    }
    // I3: computed slugify.from / template {{fields}} must name existing NON-computed
    // siblings — no chains (a computed reading another computed) and no self-reference,
    // which also rules out cycles.
    const byName = new Map(fields.map((f) => [f.name, f]));
    for (const f of fields) {
      if (!f.computed) continue;
      const refs =
        f.computed.fn === "slugify"
          ? [f.computed.from]
          : f.computed.fn === "template"
            ? [...f.computed.template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
            : [];
      for (const r of refs) {
        const sib = byName.get(r);
        if (!sib || r === f.name) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f.name}.computed references "${r}", which is not a sibling field` });
        } else if (sib.computed) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${f.name}.computed references computed field "${r}" — computed fields can't chain; reference a plain field`,
          });
        } else if (sib.localized) {
          // J5: computed fns derive from ONE string — a variant map would
          // stringify to garbage. Same rationale as the email-template bar.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${f.name}.computed references localized field "${r}" — derive from a non-localized field`,
          });
        } else if (f.publicRead && !sib.publicRead) {
          // F6 (Hostile Agent free-tier report): a PUBLIC computed field whose
          // template/slugify sources a private field would serve that value
          // verbatim on the anonymous delivery API. Reject at define — the
          // computed field's visibility may never exceed its sources'.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `${f.name} is publicRead but its computed source "${r}" is not — a public computed ` +
              `field would leak the private value on the delivery API; make "${r}" publicRead ` +
              `or make ${f.name} private`,
          });
        }
      }
    }
    // Structured fields: position-dependent depth/nesting/node rules.
    const counter = { n: 0 };
    for (const f of fields) {
      if (f.type === "group" || f.type === "array") {
        walkStructure(f as unknown as NestedNode, ctx, f.name, 1, 0, counter);
      }
    }
  });

/** Slugs that collide with admin routes or feel ambiguous in URLs. */
const RESERVED_NAMES = new Set([
  "settings",
  "api",
  "new",
  "admin",
  "v1",
  "appearance",
  "connectors",
  "assets",
  "changes", // H2: GET /v1/changes is a static route that would shadow a collection
  "checkout", // K2b: POST /v1/checkout is a static route that would shadow a collection
]);

export const collectionNameSchema = z
  .string()
  .regex(NAME_RE, "collection name must be snake_case starting with a letter")
  .refine((n) => !RESERVED_NAMES.has(n), "this name is reserved");

/** Validate a proposed collection definition. Throws ZodError on failure. */
export function validateFieldDefs(fields: unknown): FieldDef[] {
  return fieldsSchema.parse(fields) as FieldDef[];
}

/** Build the per-primitive Zod validator for one field's stored value. */
function valueSchemaFor(field: FieldDef): z.ZodTypeAny {
  switch (field.type) {
    case "text":
    case "richtext": {
      let s = z.string();
      if (typeof field.min === "number") s = s.min(field.min, `must be at least ${field.min} characters`);
      if (typeof field.max === "number") s = s.max(field.max, `must be at most ${field.max} characters`);
      if (field.type === "text" && field.pattern !== undefined) {
        const re = new RegExp(field.pattern); // compiled once per schema build
        const message = field.patternHint ?? `must match pattern ${field.pattern}`;
        // Meta-schema guarantees a numeric max whenever pattern is set.
        const lengthCap = typeof field.max === "number" ? field.max : undefined;
        return s.superRefine((val, ctx) => {
          // Values past max are already invalid — never feed them to the regex,
          // so a hostile pattern can't be handed unbounded input.
          if (lengthCap !== undefined && val.length > lengthCap) return;
          if (!re.test(val)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message,
              params: { constraint: "pattern" },
            });
          }
        });
      }
      return s;
    }
    case "number": {
      let n = z.number();
      if (field.integer) n = n.int("must be an integer");
      if (typeof field.min === "number") n = n.min(field.min, `must be >= ${field.min}`);
      if (typeof field.max === "number") n = n.max(field.max, `must be <= ${field.max}`);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "date": {
      // Accept ISO strings; reject nonsense dates. Bounds compare as instants.
      const min = typeof field.min === "string" ? field.min : undefined;
      const max = typeof field.max === "string" ? field.max : undefined;
      let d: z.ZodTypeAny = z
        .string()
        .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO date");
      if (min !== undefined) {
        d = d.refine((s: string) => Number.isNaN(Date.parse(s)) || Date.parse(s) >= Date.parse(min), {
          message: `must be on or after ${min}`,
          params: { constraint: "min" },
        });
      }
      if (max !== undefined) {
        d = d.refine((s: string) => Number.isNaN(Date.parse(s)) || Date.parse(s) <= Date.parse(max), {
          message: `must be on or before ${max}`,
          params: { constraint: "max" },
        });
      }
      // Store canonical UTC ISO so unique-index text equality = instant
      // equality ('2026-07-04T10:00+02:00' and '2026-07-04T08:00:00.000Z' collide).
      return d.transform((s: string) =>
        Number.isNaN(Date.parse(s)) ? s : new Date(s).toISOString(),
      );
    }
    case "enum":
      return z.enum(field.options as [string, ...string[]]);
    case "asset":
      // Value is an asset id (uuid). Existence checked at the DB layer.
      return z.string().uuid();
    case "relation":
      // Value is a target entry id (uuid). Existence checked at the DB layer.
      return z.string().uuid();
    case "group":
      return groupValueSchema(field.fields);
    case "array": {
      const cap = Math.min(field.maxItems ?? MAX_ARRAY_ITEMS, MAX_ARRAY_ITEMS);
      // Typed blocks: a discriminated union on the stored `_type` — each
      // element must be exactly one declared block shape (strict per block).
      if (field.blocks) {
        const variants = field.blocks.map((b) => blockValueSchema(b)) as [
          z.ZodDiscriminatedUnionOption<"_type">,
          ...z.ZodDiscriminatedUnionOption<"_type">[],
        ];
        return z.array(z.discriminatedUnion("_type", variants)).max(cap, `at most ${cap} items`);
      }
      const item = field.item!;
      const itemSchema =
        item.type === "group"
          ? groupValueSchema(item.fields)
          : valueSchemaFor(item as unknown as FieldDef);
      return z.array(itemSchema).max(cap, `at most ${cap} items`);
    }
  }
}

/** One block element: { _type: <block name>, ...its fields' value schemas }. */
function blockValueSchema(block: { name: string; fields: FieldDef[] }) {
  const shape: Record<string, z.ZodTypeAny> = { _type: z.literal(block.name) };
  for (const sub of block.fields) {
    let sv = valueSchemaFor(sub);
    if (!sub.required) sv = sv.optional();
    shape[sub.name] = sv;
  }
  return z.object(shape).strict();
}

/** A group value = a strict object of its sub-fields' value schemas (recursive).
 * Required sub-fields are required; the rest optional. No computed/localized
 * nested (barred at define time), so this stays simpler than buildEntrySchema. */
function groupValueSchema(fields: FieldDef[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const sub of fields) {
    let sv = valueSchemaFor(sub);
    if (!sub.required) sv = sv.optional();
    shape[sub.name] = sv;
  }
  return z.object(shape).strict();
}

export interface CompiledSchema {
  /** Strict Zod schema for a full entry payload. */
  schema: z.ZodType<Record<string, unknown>>;
  /** Relation/asset fields whose referenced ids must be checked against the DB. */
  refChecks: RefCheck[];
}

export interface RefCheck {
  field: string;
  kind: "relation" | "asset" | "container";
  /** For relations, the target collection slug. */
  targetCollection?: string;
  /** For containers (group/array with nested relation/asset defs): the field
   * spec verifyRefs walks to collect nested ids (v1.1 relations-in-blocks). */
  spec?: FieldDef;
}

/** Does this subtree declare any relation/asset field (needs ref-verification)? */
function containsRefDefs(f: FieldDef | { type: string; fields?: FieldDef[]; item?: unknown; blocks?: { fields: FieldDef[] }[] }): boolean {
  if (f.type === "relation" || f.type === "asset") return true;
  if (f.type === "group") return ((f as { fields?: FieldDef[] }).fields ?? []).some(containsRefDefs);
  if (f.type === "array") {
    const af = f as { item?: { type: string; fields?: FieldDef[] }; blocks?: { fields: FieldDef[] }[] };
    if (af.blocks) return af.blocks.some((b) => b.fields.some(containsRefDefs));
    if (af.item) return containsRefDefs(af.item as FieldDef);
  }
  return false;
}

/**
 * J5: compile a localized field's validator — a strict {locale: value} variant
 * map whose keys must be supported project locales and whose values reuse the
 * field's own constrained value schema (min/max/pattern apply per variant).
 * Fail-closed: without a locales context the schema rejects any value, so a
 * call site that forgot to pass it fails loudly instead of under-validating.
 */
function localizedSchemaFor(
  field: FieldDef,
  locales: ProjectLocales | null | undefined,
  requireDefault: boolean,
): z.ZodTypeAny {
  if (!locales) {
    return z.custom(() => false, {
      message: `internal: locales context missing while validating localized field "${field.name}"`,
    });
  }
  const value = valueSchemaFor(field);
  let v: z.ZodTypeAny = z
    .record(z.string(), value)
    .superRefine((map: Record<string, unknown>, ctx) => {
      const keys = Object.keys(map);
      if (keys.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "empty variant map — provide at least one locale variant or omit the field",
        });
      }
      for (const k of keys) {
        if (!locales.supported.includes(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown locale "${k}" — supported: ${locales.supported.join(", ")}`,
            params: { constraint: "locale" },
          });
        }
      }
    });
  if (requireDefault) {
    v = v.refine(
      (map: Record<string, unknown>) => map !== null && locales.default in map,
      {
        message: `required localized field must include the default locale "${locales.default}"`,
        params: { constraint: "required" },
      },
    );
  }
  return v;
}

/**
 * Compile a collection's fields[] into a strict entry validator.
 * @param partial when true (updates), all keys are optional but still typed —
 *        required-ness is only enforced on create.
 */
export function buildEntrySchema(
  fields: FieldDef[],
  partial = false,
  /** I3: 'input' (default) REJECTS a client-supplied computed key; 'storage'
   *  validates the post-stamp data where computed keys are legitimately present. */
  mode: "input" | "storage" = "input",
  /** J5: required whenever `fields` contains a localized field — localized
   *  variant maps validate against the project's supported locales. */
  locales?: ProjectLocales | null,
): CompiledSchema {
  const shape: Record<string, z.ZodTypeAny> = {};
  const refChecks: RefCheck[] = [];

  for (const field of fields) {
    let v: z.ZodTypeAny;
    if (field.computed && mode === "input") {
      // Any PRESENT value is caught by the superRefine below with a clear
      // "computed" message; absence is fine.
      v = z.unknown().optional();
    } else if (fieldLocalized(field)) {
      // Required-on-create = the DEFAULT locale's variant is present (partial
      // updates merge, so any subset of variants is a valid patch).
      v = localizedSchemaFor(field, locales, !partial && field.required === true);
      if (partial) {
        v = v.nullable().optional();
      } else if (!field.required) {
        v = v.optional();
      }
    } else {
      v = valueSchemaFor(field);
      if (partial) {
        // Updates: null = explicit unset. Required fields reject null below —
        // with a dedicated hint — so shapes stay uniform here.
        v = v.nullable().optional();
      } else if (!field.required) {
        v = v.optional();
      }
    }
    shape[field.name] = v;

    if (field.type === "relation") {
      refChecks.push({ field: field.name, kind: "relation", targetCollection: field.targetCollection });
    } else if (field.type === "asset") {
      refChecks.push({ field: field.name, kind: "asset" });
    } else if ((field.type === "group" || field.type === "array") && containsRefDefs(field)) {
      // v1.1: nested relations/assets inside groups/arrays/blocks — verifyRefs
      // walks the value with this spec so dangling nested ids reject too.
      refChecks.push({ field: field.name, kind: "container", spec: field });
    }
  }

  // .strict() => unknown keys are rejected, so an AI can't stash arbitrary data.
  let schema: z.ZodTypeAny = z.object(shape).strict();

  // I3 INPUT mode: a client (or a hook transform) may NOT supply a computed
  // field — its value is derived server-side. STORAGE mode skips this (the
  // stamped value is legitimately present).
  if (mode === "input") {
    const computed = fields.filter((f) => f.computed);
    if (computed.length > 0) {
      schema = schema.superRefine((data: Record<string, unknown>, ctx) => {
        for (const f of computed) {
          if (data[f.name] !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [f.name],
              message: `field "${f.name}" is computed (${f.computed!.fn}) — the value is derived server-side, omit it`,
              params: { constraint: "computed" },
            });
          }
        }
      });
    }
  }

  // Updates: `required` means "can never be unset" — null is rejected with a
  // dedicated hint (create-time required-ness is handled by the shapes above).
  if (partial) {
    const required = fields.filter((f) => f.required);
    if (required.length > 0) {
      schema = schema.superRefine((data: Record<string, unknown>, ctx) => {
        for (const f of required) {
          if (data[f.name] === null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [f.name],
              message: "field is required and cannot be unset",
              params: { constraint: "required" },
            });
          }
        }
      });
    }
  }

  // Conditional requireds hold at create time only, like `required`.
  const conditionals = fields.filter((f) => f.requiredIf);
  if (conditionals.length > 0 && !partial) {
    schema = schema.superRefine((data: Record<string, unknown>, ctx) => {
      for (const f of conditionals) {
        const cond = f.requiredIf!;
        if (data[cond.field] === cond.equals && data[f.name] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [f.name],
            message: `required when ${cond.field} = "${cond.equals}"`,
            params: { constraint: "required_if" },
          });
        }
      }
    });
  }

  // Structural bound: a nested value must not explode node count on write — the
  // D3/D4 lesson applied to nested content (an uncapped array/group is an OOM).
  if (fields.some((f) => f.type === "group" || f.type === "array")) {
    schema = schema.superRefine((data: Record<string, unknown>, ctx) => {
      let n = 0;
      const count = (v: unknown): void => {
        if (n > MAX_ENTRY_NODES) return;
        n++;
        if (Array.isArray(v)) v.forEach(count);
        else if (v && typeof v === "object") Object.values(v).forEach(count);
      };
      count(data);
      if (n > MAX_ENTRY_NODES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `entry has too many nested values (> ${MAX_ENTRY_NODES})`,
        });
      }
    });
  }

  return { schema: schema as z.ZodType<Record<string, unknown>>, refChecks };
}

/** Flatten a ZodError into a compact, AI-legible string. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
