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
  defaultLocale,
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
  /** J4: localized fields edit this locale's variant (J7 adds a switcher). */
  defaultLocale?: string | null;
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

  return (
    <form action={onSubmit}>
      {fields.map((f) => (
        <FieldInput
          key={f.name}
          projectId={projectId}
          field={f}
          value={initial[f.name]}
          choices={relationChoices[f.name] ?? []}
          enumOverride={enumOptionOverrides?.[f.name]}
          defaultLocale={defaultLocale}
        />
      ))}
      {error && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function VisibilityPill({ publicRead }: { publicRead?: boolean }) {
  return publicRead ? (
    <span className="chip chip-brand">
      <Globe className="h-3 w-3" />
      public
    </span>
  ) : (
    <span className="chip chip-mute">
      <Lock className="h-3 w-3" />
      admin only
    </span>
  );
}

function Label({ field, localeChip }: { field: FieldDef; localeChip?: string | null }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="text-sm font-medium">
        {field.label}
        {field.required ? <span className="text-red-500"> *</span> : null}
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
  defaultLocale,
}: {
  projectId: string;
  field: FieldDef;
  value: unknown;
  choices: RelationChoice[];
  enumOverride?: string[];
  defaultLocale?: string | null;
}) {
  // J4: a localized value is a {locale: string} variant map — edit the default
  // locale's variant (the save path wraps it back under the same locale).
  const localized = fieldLocalized(field);
  if (localized && value && typeof value === "object" && !Array.isArray(value)) {
    value = (value as Record<string, unknown>)[defaultLocale ?? ""] ?? "";
  }
  const localeChip = localized && defaultLocale ? defaultLocale : null;
  // I3: computed fields are derived server-side — show the value read-only, with
  // NO `name`, so the form never submits them (which the API would reject).
  if (field.computed) {
    return (
      <div className="mb-4">
        <Label field={field} />
        <div className={`${inputClass} bg-[--color-paper] text-[--color-ink-mute]`}>
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
