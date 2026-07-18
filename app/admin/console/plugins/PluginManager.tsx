"use client";

import { useState } from "react";
import { savePluginOverrideAction } from "../actions";

type Row = { id: string; name: string; version: string; description: string; active: boolean; priceCents: number | null };

export function PluginManager({ plugins: initial }: { plugins: Row[] }) {
  const [plugins, setPlugins] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(id: string, override: { active?: boolean; priceCents?: number | null }) {
    setBusy(id);
    setError(null);
    const r = await savePluginOverrideAction(id, override);
    setBusy(null);
    if (r.error) setError(r.error);
    else setPlugins((all) => all.map((p) => (p.id === id ? { ...p, ...override } : p)));
  }

  return (
    <div className="max-w-3xl space-y-3">
      {plugins.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-card p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {p.name} <span className="font-mono text-[10px] text-ink-mute">v{p.version} · {p.id}</span>
              {!p.active && (
                <span className="ml-2 rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-mute">
                  deactivated
                </span>
              )}
            </p>
            <p className="mt-0.5 truncate text-xs text-ink-soft">{p.description}</p>
          </div>
          <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink-mute">
            $
            <input
              type="number"
              min={0}
              step="0.01"
              defaultValue={p.priceCents != null ? (p.priceCents / 100).toFixed(2) : ""}
              placeholder="free"
              onBlur={(e) => {
                const v = e.target.value.trim();
                save(p.id, { priceCents: v === "" ? null : Math.round(Number(v) * 100) });
              }}
              className="field-input w-24 text-right"
            />
            /mo
          </label>
          <button
            type="button"
            disabled={busy === p.id}
            onClick={() => save(p.id, { active: !p.active })}
            className={p.active ? "btn btn-ghost text-xs" : "btn btn-ink text-xs"}
          >
            {busy === p.id ? "…" : p.active ? "Deactivate" : "Activate"}
          </button>
        </div>
      ))}
      {error && <p className="text-sm text-err">{error}</p>}
    </div>
  );
}
