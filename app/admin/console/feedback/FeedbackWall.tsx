"use client";

import { useState } from "react";
import { setFeedbackStatusAction } from "../actions";

type Item = {
  id: string;
  project: string;
  category: string;
  summary: string;
  detail: string | null;
  toolName: string | null;
  status: string;
  when: string;
};

const CATEGORIES = ["all", "limitation", "bug", "friction", "idea"] as const;
const STATUSES = ["new", "reviewed", "planned", "done", "dismissed"] as const;

const catColor: Record<string, string> = {
  limitation: "var(--color-warn, #a2650a)",
  bug: "var(--color-err, #b02a2a)",
  friction: "var(--color-accent, #0f766e)",
  idea: "var(--color-ok, #0e7c5f)",
};

export function FeedbackWall({ items: initial }: { items: Item[] }) {
  const [items, setItems] = useState(initial);
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const shown = items.filter((i) => (cat === "all" ? true : i.category === cat));

  async function setStatus(id: string, status: (typeof STATUSES)[number]) {
    setBusy(id);
    const r = await setFeedbackStatusAction(id, status);
    setBusy(null);
    if (!r.error) setItems((all) => all.map((i) => (i.id === id ? { ...i, status } : i)));
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCat(c)}
            className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.08em] ${
              cat === c ? "border-line-strong bg-card" : "border-line text-ink-mute hover:border-line-strong"
            }`}
          >
            {c}
            {c !== "all" && (
              <span className="ml-1.5 text-ink-mute">{items.filter((i) => i.category === c).length}</span>
            )}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-mute">
          Nothing here yet. Agents report via the <code className="font-mono text-xs">send_feedback</code> tool
          whenever they hit a wall — it lands on this page.
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((i) => (
            <div key={i.id} className="rounded-xl border border-line bg-card p-4">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: catColor[i.category] ?? "inherit", border: `1px solid currentColor` }}
                >
                  {i.category}
                </span>
                <span className="font-mono text-[11px] text-ink-mute">{i.project}</span>
                {i.toolName && <span className="font-mono text-[11px] text-line-strong">· {i.toolName}</span>}
                <span className="ml-auto font-mono text-[11px] text-line-strong">
                  {new Date(i.when).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <p className="text-sm font-medium">{i.summary}</p>
              {i.detail && <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{i.detail}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy === i.id}
                    onClick={() => setStatus(i.id, s)}
                    className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] ${
                      i.status === s ? "bg-paper font-semibold" : "text-ink-mute hover:text-ink"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
