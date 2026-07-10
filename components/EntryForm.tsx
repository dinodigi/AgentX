"use client";

import { useState } from "react";
import { Globe, Lock } from "lucide-react";
import { fieldLocalized, type FieldDef } from "@/lib/field-types";
import { AssetInput } from "./AssetInput";
import { RelationCombobox } from "./RelationCombobox";
import { RichtextInput } from "./RichtextInput";

/**
 * The auto-generated entry form. One input per primitive, derived entirely from
 * the collection's field defs — no per-collection code. Each field wears its
 * visibility (public / admin only) so a client always knows what the live site
 * can see.
 */

export interface RelationChoice {
  id: string;
  label: string;
}

const inputClass =
  "field-input";

export function EntryForm({
  projectId,
  fields,
  relationChoices,
  initial,
  action,
  enumOptionOverrides,
  locales,
  activeLocale,
}: {
  projectId: string;
  fields: FieldDef[];
  relationChoices: Record<string, RelationChoice[]>;
  initial: Record<string, unknown>;
  action: (formData: FormData) => Promise<{ error?: string } | void>;
  /** Workflow-aware option narrowing (G5): for a state-machine field, only the
   * current state + admin-reachable targets are offered (new entries: initial
   * only). UX truthfulness — the entries layer remains the enforcer. */
  enumOptionOverrides?: Record<string, string[]>;
  /** J7: project locale registry; localized fields edit activeLocale's variant
   * (carried to the save action via the hidden __locale input). */
  locales?: { default: string; supported: string[] } | null;
  activeLocale?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    const res = await action(formData);
    setPending(false);
    if (res && "error" in res && res.error) setError(res.error);
  }

  const editLocale = activeLocale ?? locales?.default ?? null;
  const hasLocalized = fields.some(fieldLocalized);

  return (
    <form action={onSubmit}>
      {/* J7: which locale's variants this form edits — the save action wraps
          localized inputs under it (and rejects it if no longer supported). */}
      {hasLocalized && editLocale ? <input type="hidden" name="__locale" value={editLocale} /> : null}
      {fields.map((f) => (
        <FieldInput
          key={f.name}
          projectId={projectId}
          field={f}
          value={initial[f.name]}
          choices={relationChoices[f.name] ?? []}
          enumOverride={enumOptionOverrides?.[f.name]}
          activeLocale={editLocale}
          supportedCount={locales?.supported.length ?? 0}
        />
      ))}
      {error && <p className="alert-error mb-3 rounded-lg px-3 py-2 text-sm">{error}</p>}
      <div className="sticky bottom-0 z-10 -mx-1 mt-2 flex items-center gap-3 border-t border-line bg-paper/95 px-1 py-3 backdrop-blur">
        <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">
          {pending ? "Saving…" : "Save changes"}
        </button>
        {hasLocalized && editLocale && (
          <span className="font-mono text-[11px] text-ink-mute">editing {editLocale}</span>
        )}
      </div>
    </form>
  );
}

/**
 * Visibility is signal, not decoration. Public is the norm — a quiet globe.
 * Admin-only is the exception worth flagging — a visible amber tag.
 */
function VisibilityPill({ publicRead }: { publicRead?: boolean }) {
  return publicRead ? (
    <Globe className="h-3.5 w-3.5 text-line-strong" aria-label="Public — served by the delivery API">
      <title>Public — served by the delivery API</title>
    </Globe>
  ) : (
    <span
      className="inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.06em]"
      style={{ color: "var(--color-warn)", borderColor: "var(--color-warn)" }}
    >
      <Lock className="h-2.5 w-2.5" />
      admin only
    </span>
  );
}

function Label({ field, localeChip }: { field: FieldDef; localeChip?: string | null }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="text-sm font-medium">
        {field.label}
        {field.required ? <span className="text-err"> *</span> : null}
      </span>
      <VisibilityPill publicRead={field.publicRead} />
      {localeChip ? <span className="chip chip-mute">{localeChip}</span> : null}
    </div>
  );
}

function FieldInput({
  projectId,
  field,
  value,
  choices,
  enumOverride,
  activeLocale,
  supportedCount,
}: {
  projectId: string;
  field: FieldDef;
  value: unknown;
  choices: RelationChoice[];
  enumOverride?: string[];
  activeLocale?: string | null;
  supportedCount?: number;
}) {
  // J7: a localized value is a {locale: string} variant map — edit the ACTIVE
  // locale's variant (the save path wraps the input back under that locale,
  // and updateEntry's merge preserves the others).
  const localized = fieldLocalized(field);
  let localeChip: string | null = null;
  if (localized && activeLocale) {
    localeChip = activeLocale;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const map = value as Record<string, unknown>;
      const translated = Object.keys(map).length;
      if (supportedCount && supportedCount > 1) {
        localeChip = `${activeLocale} · ${translated}/${supportedCount} translated`;
      }
      value = map[activeLocale] ?? "";
    }
  }
  // I3: computed fields are derived server-side — show the value read-only, with
  // NO `name`, so the form never submits them (which the API would reject).
  if (field.computed) {
    return (
      <div className="mb-4">
        <Label field={field} />
        <div className={`${inputClass} bg-paper text-ink-mute`}>
          {value != null && value !== "" ? str(value) : (
            <span className="italic">computed on save ({field.computed.fn})</span>
          )}
        </div>
      </div>
    );
  }
  switch (field.type) {
    case "text":
      return (
        <div className="mb-4">
          <Label field={field} localeChip={localeChip} />
          <input type="text" name={field.name} defaultValue={str(value)} className={inputClass} />
        </div>
      );
    case "richtext":
      return (
        <div className="mb-4">
          <Label field={field} localeChip={localeChip} />
          <RichtextInput name={field.name} initialHtml={str(value)} />
        </div>
      );
    case "number":
      return (
        <div className="mb-4">
          <Label field={field} />
          <input
            type="number"
            name={field.name}
            step="any"
            defaultValue={str(value)}
            className={inputClass}
          />
        </div>
      );
    case "boolean":
      return (
        <div className="mb-4">
          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              name={field.name}
              defaultChecked={Boolean(value)}
              value="true"
              className="h-4 w-4 accent-[var(--brand)]"
            />
            <span className="text-sm font-medium">{field.label}</span>
            <VisibilityPill publicRead={field.publicRead} />
          </label>
        </div>
      );
    case "date":
      return (
        <div className="mb-4">
          <Label field={field} />
          <input
            type="datetime-local"
            name={field.name}
            defaultValue={toLocal(value)}
            className={inputClass}
          />
        </div>
      );
    case "enum": {
      // A workflow field offers only the current state + reachable targets —
      // and always holds a state, so no empty "—" choice.
      const options = enumOverride ?? field.options;
      return (
        <div className="mb-4">
          <Label field={field} />
          <select
            name={field.name}
            defaultValue={str(value) || (enumOverride ? options[0] : "")}
            className={inputClass}
          >
            {!enumOverride && <option value="">—</option>}
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "relation":
      return (
        <div className="mb-4">
          <Label field={field} />
          <RelationCombobox name={field.name} choices={choices} initialId={relationId(value)} />
        </div>
      );
    case "asset":
      return (
        <div className="mb-4">
          <Label field={field} />
          <AssetInput projectId={projectId} name={field.name} initialId={str(value)} />
        </div>
      );
  }
}

function str(v: unknown): string {
  if (v == null) return "";
  return String(v);
}
function relationId(v: unknown): string {
  if (v && typeof v === "object" && "id" in v) return String((v as { id: unknown }).id);
  return str(v);
}
function toLocal(v: unknown): string {
  if (!v) return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
