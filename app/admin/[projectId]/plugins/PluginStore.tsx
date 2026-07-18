"use client";

import { useState } from "react";
import { Boxes, Wrench, Check } from "lucide-react";
import { togglePluginAction } from "../settings/actions";

type Card = {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  priceCents: number | null;
  hasStructure: boolean;
  tools: string[];
};

export function PluginStore({
  projectId,
  canManage,
  plugins: initial,
}: {
  projectId: string;
  canManage: boolean;
  plugins: Card[];
}) {
  const [plugins, setPlugins] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(p: Card) {
    setBusy(p.id);
    setError(null);
    const r = await togglePluginAction(projectId, p.id, !p.enabled);
    setBusy(null);
    if (r.error) setError(r.error);
    else setPlugins((all) => all.map((x) => (x.id === p.id ? { ...x, enabled: !p.enabled } : x)));
  }

  if (plugins.length === 0) {
    return <p className="card max-w-md p-6 text-sm text-ink-mute">No plugins available yet.</p>;
  }

  return (
    <>
      <div className="grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plugins.map((p) => (
          <div
            key={p.id}
            className="group flex flex-col rounded-xl border border-line bg-card p-5 transition-colors hover:border-line-strong"
          >
            <div className="mb-3 flex items-start justify-between">
              <span
                className="flex h-10 w-10 items-center justify-center rounded-lg"
                style={{ background: "var(--brand, var(--color-accent))", color: "var(--brand-ink, #fff)", opacity: 0.9 }}
              >
                <Boxes className="h-5 w-5" />
              </span>
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
                {p.priceCents ? `$${(p.priceCents / 100).toFixed(0)}/mo` : "Included"}
              </span>
            </div>
            <p className="display text-[15px] font-semibold">{p.name}</p>
            <p className="mb-1 font-mono text-[10px] text-line-strong">v{p.version} · {p.id}</p>
            <p className="mb-4 flex-1 text-[13px] leading-relaxed text-ink-soft">{p.description}</p>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {p.hasStructure && (
                <span className="rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
                  content model
                </span>
              )}
              {p.tools.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
                  <Wrench className="h-2.5 w-2.5" /> {p.tools.length} tool{p.tools.length > 1 ? "s" : ""}
                </span>
              )}
            </div>
            {p.enabled ? (
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--color-ok, #0e7c5f)" }}>
                  <Check className="h-3.5 w-3.5" /> Enabled
                </span>
                {canManage && (
                  <button type="button" disabled={busy === p.id} onClick={() => toggle(p)} className="btn btn-ghost text-xs">
                    {busy === p.id ? "…" : "Disable"}
                  </button>
                )}
              </div>
            ) : canManage ? (
              <button type="button" disabled={busy === p.id} onClick={() => toggle(p)} className="btn btn-primary w-full text-sm">
                {busy === p.id ? "Enabling…" : "Enable"}
              </button>
            ) : (
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-mute">Not enabled</span>
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-err">{error}</p>}
      <p className="mt-6 max-w-lg text-xs text-ink-mute">
        After enabling, point your agent at this project&apos;s MCP endpoint and say:
        &quot;get_plugin the enabled plugin and apply it per its reconcile notes.&quot;
      </p>
    </>
  );
}
