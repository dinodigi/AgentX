"use client";

import { useState } from "react";
import { Globe, Lock } from "lucide-react";
import type { FieldDef } from "@/lib/field-types";
import { AssetInput } from "./AssetInput";

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
}: {
  projectId: string;
  fields: FieldDef[];
  relationChoices: Record<string, RelationChoice[]>;
  initial: Record<string, unknown>;
  action: (formData: FormData) => Promise<{ error?: string } | void>;
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

function Label({ field }: { field: FieldDef }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="text-sm font-medium">
        {field.label}
        {field.required ? <span className="text-red-500"> *</span> : null}
      </span>
      <VisibilityPill publicRead={field.publicRead} />
    </div>
  );
}

function FieldInput({
  projectId,
  field,
  value,
  choices,
}: {
  projectId: string;
  field: FieldDef;
  value: unknown;
  choices: RelationChoice[];
}) {
  switch (field.type) {
    case "text":
      return (
        <div className="mb-4">
          <Label field={field} />
          <input type="text" name={field.name} defaultValue={str(value)} className={inputClass} />
        </div>
      );
    case "richtext":
      return (
        <div className="mb-4">
          <Label field={field} />
          <textarea
            name={field.name}
            defaultValue={str(value)}
            className={`${inputClass} min-h-28 resize-y`}
          />
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
    case "enum":
      return (
        <div className="mb-4">
          <Label field={field} />
          <select name={field.name} defaultValue={str(value)} className={inputClass}>
            <option value="">—</option>
            {field.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    case "relation":
      return (
        <div className="mb-4">
          <Label field={field} />
          <select name={field.name} defaultValue={relationId(value)} className={inputClass}>
            <option value="">—</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
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
