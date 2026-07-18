/**
 * The 8 field primitives. An AI composes schemas from these — never invents types.
 * This file is the single source of truth for what a field can be; validation,
 * the MCP tool surface, and the admin UI all derive from it.
 */

export const FIELD_TYPES = [
  "text",
  "richtext",
  "number",
  "boolean",
  "date",
  "enum",
  "asset",
  "relation",
  "group",
  "array",
] as const;

/**
 * Structural caps for nested group/array fields. Nesting reopens the same
 * unbounded-input DoS surface we closed for query clauses (scorecard D4), so
 * every axis is bounded: element count, nesting depth, and total node count.
 */
export const MAX_ARRAY_ITEMS = 200; // hard per-array ceiling, regardless of a field's own maxItems
export const MAX_CONTAINER_DEPTH = 5; // total group/array nesting depth (safety net)
export const MAX_ARRAY_GROUP_DEPTH = 1; // ONE level of repeating: no repeater-in-repeater — model a deeper list as a related collection (scalar sub-arrays like tags are still fine)
export const MAX_ENTRY_NODES = 2000; // total nested values across one entry's structured fields
export const MAX_BLOCK_TYPES = 20; // block vocabularies stay curated, not unbounded

export type FieldType = (typeof FIELD_TYPES)[number];

/** Common to every field definition. */
interface FieldBase {
  /** Machine name / JSONB key. Stable identifier used in entry data. */
  name: string;
  /** Human label shown in the admin. */
  label: string;
  type: FieldType;
  required?: boolean;
  /**
   * Per-field public-read visibility. When true, GET /v1/{collection} includes
   * this field. When false/absent, the field is admin-only and never leaves the API.
   * This is the per-field granularity the brief asks for.
   */
  publicRead?: boolean;
  /**
   * Scale A2: create a matching DB index so filtering/sorting by this field is a
   * SEEK, not a scan, on collections that grow large. Set it for the fields you
   * query by (status, category, price…) — not everything; each index taxes
   * writes. `unique` and `searchable` already imply their own index. Not valid on
   * richtext (use `searchable`) or group/array (nested content isn't queryable).
   */
  indexed?: boolean;
  /**
   * Value must be unique within the collection (text/number/date). Enforced by
   * a partial DB index, so concurrent writers can't race past it. Date values
   * are stored normalized to UTC ISO-8601 so index equality = instant equality.
   */
  unique?: boolean;
  /** Required only when a sibling enum field holds a specific option (create-time). */
  requiredIf?: { field: string; equals: string };
  /**
   * Field-level write gate for the DELIVERY API only (admin/MCP unaffected):
   * "none" = never writable via delivery; {claim, equals} = writable only by a
   * matching verified user. Server-stamped identity fields are exempt.
   */
  writableBy?: "none" | { claim: string; equals: string | string[] };
  /**
   * I3: the value is DERIVED server-side from a closed vocabulary — the client
   * never supplies it (a supplied value is rejected). slugify/template/uuid on
   * text, now on date. Computed fields can't be required/requiredIf.
   */
  computed?: ComputedSpec;
}

/** Closed computed-field vocabulary (I3). No expression language, ever. */
export type ComputedSpec =
  | { fn: "slugify"; from: string } // lowercase ascii slug of a sibling text field
  | { fn: "template"; template: string } // {{field}} interpolation of siblings
  | { fn: "now"; on?: "create" | "always" } // ISO timestamp (I4 adds on:'always')
  | { fn: "uuid" }; // crypto.randomUUID at create

export interface TextField extends FieldBase {
  type: "text";
  /** min/max LENGTH bounds. */
  min?: number;
  max?: number;
  /**
   * JS RegExp source the value must match. Requires max (<= 10000) so a hostile
   * pattern can never be fed unbounded input; nested quantifiers are rejected.
   */
  pattern?: string;
  /** Returned verbatim when a value fails pattern — write it as a fix hint. */
  patternHint?: string;
  /** Include this field in full-text search (search_entries / delivery ?q=). */
  searchable?: boolean;
  /**
   * J4/J5: value is a {locale: string} variant map validated against the
   * project's locales; delivery serves one flat locale (default, or ?locale=).
   * Requires set_locales; text/richtext only.
   */
  localized?: boolean;
}
export interface RichTextField extends FieldBase {
  type: "richtext";
  /** min/max LENGTH bounds. */
  min?: number;
  max?: number;
  /** Include this field (HTML tags stripped) in full-text search. */
  searchable?: boolean;
  /** J4/J5: {locale: value} variant map — see TextField.localized. */
  localized?: boolean;
}
export interface NumberField extends FieldBase {
  type: "number";
  /** min/max VALUE bounds. */
  min?: number;
  max?: number;
  /** Reject non-whole values (guards increment results too). */
  integer?: boolean;
}
export interface BooleanField extends FieldBase {
  type: "boolean";
}
export interface DateField extends FieldBase {
  type: "date";
  /** min/max ISO-string VALUE bounds (compared as instants). */
  min?: string;
  max?: string;
}
export interface EnumField extends FieldBase {
  type: "enum";
  /** Allowed values. Stored value must be one of these. */
  options: string[];
}
export interface AssetField extends FieldBase {
  type: "asset";
}
export interface RelationField extends FieldBase {
  type: "relation";
  /** Slug of the collection this field links to. */
  targetCollection: string;
  /** Field on the target used as the human label when resolving to {id, label}. */
  labelField: string;
}

/** A nested set of named sub-fields. Used as a field and as an array element. */
export interface GroupField extends FieldBase {
  type: "group";
  fields: FieldDef[];
}

/**
 * One array element. Scalar leaves are positional (no name); a `group` repeats a
 * nested shape. No `array` here — arrays never directly nest arrays (depth is via
 * array → group → array, capped at MAX_ARRAY_GROUP_DEPTH).
 */
export type ArrayItem =
  | { type: "text"; min?: number; max?: number; pattern?: string; patternHint?: string }
  | { type: "richtext"; min?: number; max?: number }
  | { type: "number"; min?: number; max?: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "date"; min?: string; max?: string }
  | { type: "enum"; options: string[] }
  | { type: "asset" }
  | { type: "group"; fields: FieldDef[] };

/**
 * One typed block in a heterogeneous `blocks` array. Stored elements carry the
 * block's `name` as their `_type` discriminator: {"_type":"hero", ...fields}.
 * A block's fields follow the same nested-field rules as a repeated group
 * (one-level rule: no repeater-of-groups/blocks inside a block).
 */
export interface BlockDef {
  /** Machine name — the stored `_type` discriminator. */
  name: string;
  label: string;
  fields: FieldDef[];
}

/**
 * A repeatable field. Exactly ONE of:
 *  - `item`   — uniform repeater: every element is the same scalar/group shape.
 *  - `blocks` — typed blocks: each element is one of several named shapes
 *               (hero, features, cta…), discriminated by its stored `_type`.
 *               This is what makes a page body a real builder.
 */
export interface ArrayField extends FieldBase {
  type: "array";
  item?: ArrayItem;
  blocks?: BlockDef[];
  /** Element cap (author-set); MAX_ARRAY_ITEMS applies as a hard ceiling regardless. */
  maxItems?: number;
}

export type FieldDef =
  | TextField
  | RichTextField
  | NumberField
  | BooleanField
  | DateField
  | EnumField
  | AssetField
  | RelationField
  | GroupField
  | ArrayField;

/** Read a type-specific knob from any field def without narrowing at the call site. */
export const fieldSearchable = (f: FieldDef): boolean =>
  (f.type === "text" || f.type === "richtext") && f.searchable === true;
export const fieldMin = (f: FieldDef): number | string | undefined => ("min" in f ? f.min : undefined);
export const fieldMax = (f: FieldDef): number | string | undefined => ("max" in f ? f.max : undefined);
export const fieldPattern = (f: FieldDef): string | undefined => (f.type === "text" ? f.pattern : undefined);
export const fieldInteger = (f: FieldDef): boolean | undefined => (f.type === "number" ? f.integer : undefined);
export const fieldComputed = (f: FieldDef): ComputedSpec | undefined => f.computed;
export const fieldLocalized = (f: FieldDef): boolean =>
  (f.type === "text" || f.type === "richtext") && f.localized === true;

/**
 * Terse, machine-readable description of each primitive and its config knobs.
 * Returned verbatim by the MCP `list_field_types` tool so the AI composes valid
 * schemas without guessing.
 */
export const FIELD_TYPE_SPECS: Record<
  FieldType,
  { summary: string; config: string[] }
> = {
  text: {
    summary: "Single-line or short plain text.",
    config: [
      "unique?: boolean",
      "min/max?: number (LENGTH bounds)",
      "pattern?: string (JS RegExp source the value must match; requires max <= 10000)",
      "patternHint?: string (returned verbatim on pattern failure — write it as a fix hint)",
      "searchable?: boolean (include in full-text search)",
    ],
  },
  richtext: {
    summary: "Formatted long-form body content (stored as HTML/markdown).",
    config: ["min/max?: number (LENGTH bounds)", "searchable?: boolean (tags stripped for search)"],
  },
  number: {
    summary: "Numeric value (int or float).",
    config: [
      "unique?: boolean",
      "min/max?: number (VALUE bounds)",
      "integer?: boolean (reject non-whole values; update_entry_if increments must be whole too)",
    ],
  },
  boolean: { summary: "True/false toggle.", config: [] },
  date: {
    summary: "ISO-8601 date/datetime. Values are stored normalized to UTC ISO-8601.",
    config: [
      "unique?: boolean (instant-level: the same moment in two offsets collides)",
      "min/max?: ISO string (VALUE bounds, compared as instants)",
    ],
  },
  enum: { summary: "One value from a fixed option list.", config: ["options: string[] (required)"] },
  asset: { summary: "Reference to an uploaded file (id from upload_asset).", config: [] },
  relation: {
    summary: "Link to an entry in another collection.",
    config: ["targetCollection: string (required)", "labelField: string (required)"],
  },
  group: {
    summary: "A nested set of sub-fields — structured content (e.g. an `seo` group).",
    config: [
      "fields: FieldDef[] (required — the nested sub-fields, each with its own name/label/publicRead)",
      "sub-fields MAY be relation (point a group/block at another collection — delivery resolves " +
        "it to {id,label}); they can't be computed/localized/unique/searchable/requiredIf yet",
    ],
  },
  array: {
    summary:
      "A repeatable list — a uniform repeater (item) OR typed blocks (blocks: hero/features/cta…, " +
      "each element one of several named shapes). Exactly one of item|blocks.",
    config: [
      "item: {type,...scalar} | {type:'group',fields:[...]} — uniform repeater: every element the same shape",
      "blocks: [{name,label,fields:[...]}, ...] — TYPED BLOCKS for page bodies: each element is one " +
        "of the named shapes and stores its block name as `_type` " +
        '(e.g. {"_type":"hero","heading":"…"}). Up to 20 block types; block names snake_case and ' +
        "unique; `_type` is reserved (never define a field with that name). Use this when a page is " +
        "a sequence of DIFFERENT sections; use item when every element is the same shape.",
      "maxItems?: number (element cap; hard ceiling 200 regardless)",
      "ONE level of repeating: a repeater/block item may NOT contain another repeater-of-groups or " +
        "blocks; model a deeper/repeating list as its own collection + a RELATION FIELD inside the " +
        "block/group (allowed — resolves to {id,label} on delivery; e.g. a services block = " +
        "{heading, items: relation→services}). Scalar sub-arrays like tags inside an item are fine.",
    ],
  },
};

/** Constraint knobs available on every field, shown by list_field_types. */
export const COMMON_FIELD_CONFIG = [
  "required?: boolean (enforced on create; on update the field rejects null — it can never be unset)",
  'requiredIf?: {field, equals} — required only when a sibling ENUM field equals an option (create-time)',
  "publicRead?: boolean (delivery visibility)",
  "indexed?: boolean — build a DB index so FILTER/SORT by this field stays fast as the " +
    "collection grows. Set it on the fields you query by (status, category, price, date); NOT " +
    "on everything (each index taxes writes). unique/searchable already imply an index. Invalid " +
    "on richtext (use searchable) and group/array (nested content isn't queryable).",
  'writableBy?: "none" | {claim, equals} — delivery-only write gate (admin/MCP unaffected). ' +
    "Use writableBy:'none' to lock an admin-only field on a publicWrite collection. " +
    "Fields referenced by the collection's publicFilter are auto-locked against anonymous writes.",
  "in update calls, set a field to null to unset it (optional fields only)",
  "computed?: {fn} — value DERIVED server-side, never client-supplied (a supplied value is " +
    "rejected). fn: {slugify, from:<sibling text field>} | {template, template:'{{a}}-{{b}}'} | " +
    "{now, on?:'create'|'always'} (date) | {uuid}. slugify/template/uuid on text, now on date; " +
    "can't be required; references must be plain (non-computed) siblings. Stamped at create; on " +
    "UPDATE slugify/template recompute when a source field changes and now:'always' restamps, " +
    "while uuid + now:'create' stay frozen (update_entry_if/CAS never recomputes).",
  "localized?: boolean (text/richtext; requires set_locales first) — the value is a " +
    "{locale: string} variant map validated against the project's supported locales; required = " +
    "the default locale's variant present at create. Delivery serves ONE flat string (the default " +
    "locale); MCP reads return the raw map. update_entry MERGES variant maps ({de:...} preserves " +
    "en; there is no per-variant unset). Localized fields can't be unique/searchable/computed, " +
    "can't be filtered or sorted, and can't back a relation labelField or an email template. " +
    "Toggling on a populated field: localizing wraps values under the default locale " +
    "(non-destructive); delocalizing keeps only the default variant (plan + confirm).",
];
