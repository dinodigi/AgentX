import { fieldLocalized, type FieldDef } from "./field-types";

/**
 * Convert an HTML FormData payload into a typed entry object the validation
 * core accepts. The admin renders string inputs; this coerces each value to the
 * primitive its field expects. Empty optional values are omitted so the schema
 * treats them as absent.
 *
 * J7: a localized field's input edits ONE locale — the form's active locale
 * (hidden __locale input) — and is wrapped as {locale: value}; updateEntry's
 * variant merge (J5) preserves the other locales.
 */
export function coerceFormData(
  fields: FieldDef[],
  formData: FormData,
  wrapLocale?: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = formData.get(f.name);

    if (f.type === "boolean") {
      out[f.name] = raw === "true" || raw === "on";
      continue;
    }

    const s = raw == null ? "" : String(raw).trim();
    if (s === "") continue; // omit empties; required-ness enforced by validation

    switch (f.type) {
      case "number":
        out[f.name] = Number(s);
        break;
      case "date":
        out[f.name] = new Date(s).toISOString();
        break;
      default:
        // text, richtext, enum, asset (id), relation (id)
        out[f.name] = fieldLocalized(f) && wrapLocale ? { [wrapLocale]: s } : s;
    }
  }
  return out;
}
