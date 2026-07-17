"use client";

import { useState } from "react";
import type { FieldDef, ArrayItem, BlockDef } from "@/lib/field-types";

/**
 * Visual editor for group/array (structured) fields (Layer 3b). Holds the value
 * in React state and serializes it to ONE hidden input — coerceFormData JSON-
 * parses that back, so the server path is unchanged. Nested inputs are controlled
 * (no FormData names of their own). Add/remove for arrays; reorder is a later
 * polish. The server still validates the result (recursive schema + caps).
 */
type Spec = FieldDef | ArrayItem;

export function StructuredFieldEditor({
  projectId,
  name,
  field,
  initial,
}: {
  projectId: string;
  name: string;
  field: FieldDef;
  initial: unknown;
}) {
  const [value, setValue] = useState<unknown>(initial ?? (field.type === "array" ? [] : {}));
  const serialized = isEmptyStructured(value) ? "" : JSON.stringify(value);
  return (
    <div>
      {/* Empty ⇒ "" so an untouched optional group/array is omitted, not sent as {} */}
      <input type="hidden" name={name} value={serialized} />
      <NodeEditor projectId={projectId} spec={field} value={value} onChange={setValue} />
    </div>
  );
}

function NodeEditor({
  projectId,
  spec,
  value,
  onChange,
}: {
  projectId: string;
  spec: Spec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (spec.type === "group") {
    return <GroupEditor projectId={projectId} fields={spec.fields} value={value} onChange={onChange} />;
  }
  if (spec.type === "array") {
    return (
      <ArrayEditor projectId={projectId} item={spec.item} blocks={spec.blocks} value={value} onChange={onChange} />
    );
  }
  return <LeafEditor projectId={projectId} spec={spec} value={value} onChange={onChange} />;
}

function GroupEditor({
  projectId,
  fields,
  value,
  onChange,
}: {
  projectId: string;
  fields: FieldDef[];
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return (
    <div className="space-y-3 rounded-lg border border-line bg-paper/50 p-3">
      {fields.map((sub) => (
        <div key={sub.name}>
          <label className="mb-1 block text-xs font-medium text-ink-soft">
            {sub.label}
            {sub.required ? <span className="text-err"> *</span> : null}
            {sub.publicRead === false ? (
              <span className="ml-1.5 font-mono text-[9px] uppercase text-ink-mute">admin only</span>
            ) : null}
          </label>
          <NodeEditor
            projectId={projectId}
            spec={sub}
            value={obj[sub.name]}
            onChange={(v) => onChange({ ...obj, [sub.name]: v })}
          />
        </div>
      ))}
    </div>
  );
}

function ArrayEditor({
  projectId,
  item,
  blocks,
  value,
  onChange,
}: {
  projectId: string;
  item?: ArrayItem;
  blocks?: BlockDef[];
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const arr = Array.isArray(value) ? value : [];
  // Typed blocks: each element edits through the block matching its `_type`.
  const blockFor = (el: unknown): BlockDef | undefined => {
    if (!blocks || !el || typeof el !== "object") return undefined;
    return blocks.find((b) => b.name === (el as Record<string, unknown>)._type);
  };
  return (
    <div className="space-y-2">
      {arr.map((el, i) => {
        const block = blockFor(el);
        const spec: Spec | undefined = blocks
          ? block && ({ type: "group", fields: block.fields } as ArrayItem)
          : item;
        return (
          <div key={i} className="rounded-lg border border-line p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[11px] text-ink-mute">
                #{i + 1}
                {block ? <span className="ml-1.5 uppercase tracking-[0.08em] text-ink-soft">{block.label}</span> : null}
              </span>
              <button
                type="button"
                onClick={() => onChange(arr.filter((_, idx) => idx !== i))}
                className="text-xs text-err hover:underline"
              >
                Remove
              </button>
            </div>
            {spec ? (
              <NodeEditor
                projectId={projectId}
                spec={spec}
                value={el}
                onChange={(v) =>
                  onChange(
                    arr.map((old, idx) =>
                      idx === i
                        ? // keep the discriminator when editing a block element
                          block && v && typeof v === "object"
                          ? { ...(v as Record<string, unknown>), _type: block.name }
                          : v
                        : old,
                    ),
                  )
                }
              />
            ) : (
              <p className="text-xs text-ink-mute">unknown block type — edit as JSON in the raw field</p>
            )}
          </div>
        );
      })}
      {blocks ? (
        blocks.map((b) => (
          <button
            key={b.name}
            type="button"
            onClick={() => onChange([...arr, { _type: b.name }])}
            className="btn btn-ghost mr-2 text-xs"
          >
            + {b.label}
          </button>
        ))
      ) : (
        <button
          type="button"
          onClick={() => onChange([...arr, emptyValue(item!)])}
          className="btn btn-ghost text-xs"
        >
          + Add item
        </button>
      )}
    </div>
  );
}

function LeafEditor({
  projectId,
  spec,
  value,
  onChange,
}: {
  projectId: string;
  spec: Exclude<Spec, { type: "group" } | { type: "array" }>;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const cls = "field-input";
  switch (spec.type) {
    case "text":
      return <input type="text" value={str(value)} onChange={(e) => onChange(e.target.value)} className={cls} />;
    case "richtext":
      return (
        <textarea value={str(value)} onChange={(e) => onChange(e.target.value)} className={cls} rows={3} />
      );
    case "number":
      return (
        <input
          type="number"
          step="any"
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className={cls}
        />
      );
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-[var(--brand)]"
        />
      );
    case "date":
      return (
        <input
          type="datetime-local"
          value={toLocal(value)}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)}
          className={cls}
        />
      );
    case "enum":
      return (
        <select value={str(value)} onChange={(e) => onChange(e.target.value || undefined)} className={cls}>
          <option value="">—</option>
          {spec.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "asset":
      return <ControlledAsset projectId={projectId} value={str(value)} onChange={onChange} />;
  }
}

function ControlledAsset({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string;
  onChange: (v: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("projectId", projectId);
    fd.append("file", file);
    const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
    setBusy(false);
    if (res.ok) onChange((await res.json()).id);
  }
  return (
    <div>
      <input type="file" onChange={onFile} disabled={busy} className="block text-xs text-ink-soft" />
      {busy && <p className="mt-1 text-xs text-ink-mute">Uploading…</p>}
      {value && !busy && <p className="mt-1 font-mono text-[11px] text-ink-mute">asset: {value}</p>}
    </div>
  );
}

function emptyValue(item: ArrayItem): unknown {
  if (item.type === "group") return {};
  if (item.type === "boolean") return false;
  return "";
}
function isEmptyStructured(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === "object") return Object.keys(v).length === 0;
  return v == null;
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function toLocal(v: unknown): string {
  if (!v) return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
