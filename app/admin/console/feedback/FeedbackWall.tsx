"use client";

import { useState } from "react";
import { setFeedbackStatusAction, bulkResolveFeedbackAction } from "../actions";

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

// Status pipeline colors — one hue per stage, used identically in the summary
// bar and on every card so the board reads at a glance:
// new = needs eyes · reviewed = triaged · planned = tracked in BACKLOG/plans ·
// done = shipped · dismissed = won't do.
const statusColor: Record<string, string> = {
  new: "var(--color-warn, #d9a514)",
  reviewed: "#5aa9e6",
  planned: "#a78bfa",
  done: "var(--color-ok, #43de83)",
  dismissed: "#8a8f98",
};

function Stat({ n, label, color, dimZero = true }: { n: number; label: string; color: string; dimZero?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span
        className="font-mono text-lg font-semibold tabular-nums"
        style={{ color: n > 0 || !dimZero ? color : undefined, opacity: n === 0 && dimZero ? 0.35 : 1 }}
      >
        {n}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">{label}</span>
    </span>
  );
}

export function FeedbackWall({ items: initial }: { items: Item[] }) {
  const [items, setItems] = useState(initial);
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>("all");
  const [proj, setProj] = useState<string>("all");
  const [grouped, setGrouped] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const projects = [...new Set(items.map((i) => i.project))].sort();
  const shown = items.filter(
    (i) =>
      (cat === "all" || i.category === cat) &&
      (proj === "all" || i.project === proj) &&
      (!openOnly || (i.status !== "done" && i.status !== "dismissed")),
  );

  const OPEN = new Set(["new", "reviewed", "planned"]);
  const byStatus = (s: string) => items.filter((i) => i.status === s).length;
  const counts = {
    total: items.length,
    open: items.filter((i) => OPEN.has(i.status)).length,
    // The INBOX number — what actually needs a human. `planned` is deliberately
    // NOT in it: planned = triaged into BACKLOG/plans, waiting on scheduling.
    inbox: byStatus("new") + byStatus("reviewed"),
    new: byStatus("new"),
    reviewed: byStatus("reviewed"),
    planned: byStatus("planned"),
    done: byStatus("done"),
    dismissed: byStatus("dismissed"),
  };

  async function setStatus(id: string, status: (typeof STATUSES)[number]) {
    setBusy(id);
    const r = await setFeedbackStatusAction(id, status);
    setBusy(null);
    if (!r.error) setItems((all) => all.map((i) => (i.id === id ? { ...i, status } : i)));
  }

  async function bulkResolve(status: "done" | "dismissed") {
    const label = cat === "all" ? "all open items" : `all open ${cat} items`;
    if (!confirm(`Mark ${label} as ${status}?`)) return;
    setBusy("bulk");
    const r = await bulkResolveFeedbackAction(cat, status);
    setBusy(null);
    if (!r.error) {
      setItems((all) =>
        all.map((i) =>
          OPEN.has(i.status) && (cat === "all" || i.category === cat) ? { ...i, status } : i,
        ),
      );
    }
  }

  // When grouped, section the shown items by project (most items first).
  const groups = grouped
    ? [...new Set(shown.map((i) => i.project))]
        .map((name) => ({ name, items: shown.filter((i) => i.project === name) }))
        .sort((a, b) => b.items.length - a.items.length)
    : [{ name: null as string | null, items: shown }];

  const card = (i: Item) => (
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
                    style={
                      i.status === s
                        ? { color: statusColor[s], border: "1px solid currentColor" }
                        : { border: "1px solid transparent" }
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
  );

  return (
    <div className="max-w-3xl">
      {/* Summary bar — the full status pipeline at a glance + bulk resolve.
          "new" is the only number that means "a human needs to look". */}
      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-card px-5 py-3">
        <Stat n={counts.new} label="new" color={statusColor.new} />
        <Stat n={counts.reviewed} label="reviewed" color={statusColor.reviewed} />
        <Stat n={counts.planned} label="planned" color={statusColor.planned} />
        <Stat n={counts.done} label="done" color={statusColor.done} dimZero={false} />
        <Stat n={counts.dismissed} label="dismissed" color={statusColor.dismissed} />
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-line-strong">
            bulk {cat === "all" ? "(all)" : `(${cat})`}
          </span>
          <button
            type="button"
            disabled={busy === "bulk" || counts.open === 0}
            onClick={() => bulkResolve("done")}
            className="btn btn-ghost text-xs disabled:opacity-40"
          >
            Resolve open → done
          </button>
          <button
            type="button"
            disabled={busy === "bulk" || counts.open === 0}
            onClick={() => bulkResolve("dismissed")}
            className="btn btn-ghost text-xs disabled:opacity-40"
          >
            Dismiss open
          </button>
        </span>
      </div>

      {/* Controls: category chips + project filter + group/open toggles */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
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
            {c !== "all" && <span className="ml-1.5 text-ink-mute">{items.filter((i) => i.category === c).length}</span>}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-line" />
        <select
          value={proj}
          onChange={(e) => setProj(e.target.value)}
          className="field-input h-8 w-auto py-0 text-xs"
          aria-label="Filter by project"
        >
          <option value="all">All projects ({items.length})</option>
          {projects.map((name) => (
            <option key={name} value={name}>
              {name} ({items.filter((i) => i.project === name).length})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink-mute">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} className="h-3.5 w-3.5" />
          group by project
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink-mute">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} className="h-3.5 w-3.5" />
          open only
        </label>
      </div>

      {shown.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-mute">
          {items.length === 0 ? (
            <>
              Nothing here yet. Agents report via the <code className="font-mono text-xs">send_feedback</code> tool
              whenever they hit a wall — it lands on this page.
            </>
          ) : (
            "No items match these filters."
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.name ?? "_all"}>
              {g.name !== null && (
                <div className="mb-2 flex items-baseline gap-2 border-b border-line pb-1.5">
                  <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em]">{g.name}</h2>
                  <span className="font-mono text-[11px] text-ink-mute">{g.items.length}</span>
                </div>
              )}
              <div className="space-y-3">{g.items.map(card)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
