import { fieldLocalized, type FieldDef } from "./field-types";

/**
 * Convert an HTML FormData payload into a typed entry object the validation
 * core accepts. The admin renders string inputs; this coerces each value to the
 * primitive its field expects. Empty optional values are omitted so the schema
 * treats them as absent.
 *
 * J4: a localized field's input edits ONE locale (the default until J7's
 * switcher) — the value is wrapped as {locale: value}; updateEntry's variant
 * merge (J5) preserves the other locales.
 */
export function coerceFormData(
  fields: FieldDef[],
  formData: FormData,
  defaultLocale?: string | null,
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
        out[f.name] = fieldLocalized(f) && defaultLocale ? { [defaultLocale]: s } : s;
    }
  }
  return out;
}
