"use client";

import { useState } from "react";
import { Boxes, Wrench, Check, Terminal } from "lucide-react";
import { togglePluginAction } from "../settings/actions";

/**
 * The plugin store for one project.
 *
 * Three things were wrong with the first version, all about the same thing —
 * the page did not answer "what is on this project?" at a glance:
 *
 *  · Enabled and available cards were mixed in one grid, so a project's actual
 *    state had to be assembled by reading every card.
 *  · The grid was capped at max-w-4xl, so it never used more than three columns
 *    however wide the window was.
 *  · The instruction for what to do AFTER enabling — the step that actually
 *    makes a plugin do anything — sat at the bottom of the page in small grey
 *    text, detached from the card that needed it.
 *
 * Enabling is only half the job: the project's agent still has to apply the
 * plugin over MCP. So that instruction now lives ON each enabled card, where it
 * is the obvious next action rather than a footnote.
 */

type Card = {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  priceCents: number | null;
  hasStructure: boolean;
  tools: string[];
  provides: string[];
  requires: string[];
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
  const [copied, setCopied] = useState<string | null>(null);

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

  const enabled = plugins.filter((p) => p.enabled);
  const available = plugins.filter((p) => !p.enabled);

  const prompt = (id: string) => `get_plugin ${id} and apply it per its reconcile notes`;

  const card = (p: Card) => (
    <div
      key={p.id}
      className="flex flex-col rounded-xl border bg-card p-5 transition-colors hover:border-line-strong"
      style={{ borderColor: p.enabled ? "color-mix(in srgb, var(--color-ok) 45%, transparent)" : undefined }}
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
      <p className="mb-1 font-mono text-[10px] text-line-strong">
        v{p.version} · {p.id}
      </p>
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
        {p.provides.map((cap) => (
          <span
            key={cap}
            className="rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em]"
            style={{ color: "var(--color-accent, #0f766e)" }}
          >
            provides {cap}
          </span>
        ))}
        {p.requires.length > 0 && (
          <span className="rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
            needs {p.requires.join(", ")}
          </span>
        )}
      </div>

      {p.enabled ? (
        <>
          {/* Enabling records the capability; the agent still has to apply it.
              That step belongs here, not in a footnote nobody reads. */}
          <div className="mb-3 rounded-lg border border-line bg-paper p-2.5">
            <p className="m-0 mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute">
              <Terminal className="h-3 w-3" /> next — tell your agent
            </p>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(prompt(p.id));
                setCopied(p.id);
                setTimeout(() => setCopied((c) => (c === p.id ? null : c)), 1600);
              }}
              className="w-full rounded border border-line bg-card px-2 py-1.5 text-left font-mono text-[10.5px] leading-relaxed text-ink-soft hover:border-line-strong"
              title="Copy this instruction"
            >
              {copied === p.id ? "copied ✓" : prompt(p.id)}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span
              className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: "var(--color-ok, #0e7c5f)" }}
            >
              <Check className="h-3.5 w-3.5" /> Enabled
            </span>
            {canManage && (
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => toggle(p)}
                className="btn btn-ghost text-xs"
              >
                {busy === p.id ? "…" : "Disable"}
              </button>
            )}
          </div>
        </>
      ) : canManage ? (
        <button
          type="button"
          disabled={busy === p.id}
          onClick={() => toggle(p)}
          className="btn btn-primary w-full text-sm"
        >
          {busy === p.id ? "Enabling…" : "Enable"}
        </button>
      ) : (
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-mute">Not enabled</span>
      )}
    </div>
  );

  const section = (title: string, list: Card[], hint?: string) =>
    list.length === 0 ? null : (
      <section className="mb-8">
        <div className="mb-3 flex items-baseline gap-2 border-b border-line pb-1.5">
          <h2 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-ink">{title}</h2>
          <span className="font-mono text-[11px] text-ink-mute">{list.length}</span>
          {hint && <span className="ml-auto text-[12px] text-ink-mute">{hint}</span>}
        </div>
        {/* auto-fill rather than a fixed column count, so the grid uses the width
            it is actually given instead of stopping at three. */}
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
          {list.map(card)}
        </div>
      </section>
    );

  return (
    <>
      {enabled.length === 0 && (
        <p className="mb-6 rounded-xl border border-line bg-card px-5 py-4 text-[13px] leading-relaxed text-ink-mute">
          Nothing enabled on this project yet. Enabling a plugin records the capability — your agent then applies
          it over MCP, and the copyable instruction appears on the card.
        </p>
      )}
      {section("Enabled on this project", enabled, "your agent applies these over MCP")}
      {section("Available", available)}
      {error && <p className="mt-3 text-sm text-err">{error}</p>}
    </>
  );
}
