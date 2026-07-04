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
] as const;

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
}

export interface TextField extends FieldBase {
  type: "text";
}
export interface RichTextField extends FieldBase {
  type: "richtext";
}
export interface NumberField extends FieldBase {
  type: "number";
}
export interface BooleanField extends FieldBase {
  type: "boolean";
}
export interface DateField extends FieldBase {
  type: "date";
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

export type FieldDef =
  | TextField
  | RichTextField
  | NumberField
  | BooleanField
  | DateField
  | EnumField
  | AssetField
  | RelationField;

/**
 * Terse, machine-readable description of each primitive and its config knobs.
 * Returned verbatim by the MCP `list_field_types` tool so the AI composes valid
 * schemas without guessing.
 */
export const FIELD_TYPE_SPECS: Record<
  FieldType,
  { summary: string; config: string[] }
> = {
  text: { summary: "Single-line or short plain text.", config: [] },
  richtext: { summary: "Formatted long-form body content (stored as HTML/markdown).", config: [] },
  number: { summary: "Numeric value (int or float).", config: [] },
  boolean: { summary: "True/false toggle.", config: [] },
  date: { summary: "ISO-8601 date/datetime.", config: [] },
  enum: { summary: "One value from a fixed option list.", config: ["options: string[] (required)"] },
  asset: { summary: "Reference to an uploaded file (id from upload_asset).", config: [] },
  relation: {
    summary: "Link to an entry in another collection.",
    config: ["targetCollection: string (required)", "labelField: string (required)"],
  },
};
