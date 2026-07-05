import { z } from "zod";
import { FIELD_TYPES, type FieldDef } from "./field-types";

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

/** Thrown for any agent-repairable input problem; message doubles as the fix hint. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Meta-schema: the shape of a single field definition. */
const fieldDefSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(NAME_RE, "field name must be snake_case starting with a letter"),
    label: z.string().min(1),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    publicRead: z.boolean().optional(),
    // type-specific, validated by superRefine below
    options: z.array(z.string().min(1)).optional(),
    targetCollection: z.string().regex(NAME_RE).optional(),
    labelField: z.string().regex(NAME_RE).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
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
  });

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
    case "richtext":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "date":
      // Accept ISO strings; reject nonsense dates.
      return z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO date");
    case "enum":
      return z.enum(field.options as [string, ...string[]]);
    case "asset":
      // Value is an asset id (uuid). Existence checked at the DB layer.
      return z.string().uuid();
    case "relation":
      // Value is a target entry id (uuid). Existence checked at the DB layer.
      return z.string().uuid();
  }
}

export interface CompiledSchema {
  /** Strict Zod schema for a full entry payload. */
  schema: z.ZodType<Record<string, unknown>>;
  /** Relation/asset fields whose referenced ids must be checked against the DB. */
  refChecks: RefCheck[];
}

export interface RefCheck {
  field: string;
  kind: "relation" | "asset";
  /** For relations, the target collection slug. */
  targetCollection?: string;
}

/**
 * Compile a collection's fields[] into a strict entry validator.
 * @param partial when true (updates), all keys are optional but still typed —
 *        required-ness is only enforced on create.
 */
export function buildEntrySchema(fields: FieldDef[], partial = false): CompiledSchema {
  const shape: Record<string, z.ZodTypeAny> = {};
  const refChecks: RefCheck[] = [];

  for (const field of fields) {
    let v = valueSchemaFor(field);
    const isRequired = field.required && !partial;
    if (!isRequired) v = v.optional();
    shape[field.name] = v;

    if (field.type === "relation") {
      refChecks.push({ field: field.name, kind: "relation", targetCollection: field.targetCollection });
    } else if (field.type === "asset") {
      refChecks.push({ field: field.name, kind: "asset" });
    }
  }

  // .strict() => unknown keys are rejected, so an AI can't stash arbitrary data.
  const schema = z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
  return { schema, refChecks };
}

/** Flatten a ZodError into a compact, AI-legible string. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
