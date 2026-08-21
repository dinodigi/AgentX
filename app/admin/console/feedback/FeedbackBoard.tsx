"use client";

import { useMemo, useState } from "react";
import { setFeedbackStatusAction, bulkResolveFeedbackAction } from "../actions";

/**
 * The feedback wall as a BOARD.
 *
 * It was a single filtered column capped at `max-w-3xl`, where every card
 * rendered its whole payload inline — full detail, the entire evidence block,
 * verification badges and five status buttons. At 140 items that is a very long
 * scroll in which the ten that need attention look identical to the hundred and
 * thirty that are finished.
 *
 * Columns come from the status pipeline that already existed, so this is a new
 * VIEW of the same vocabulary rather than a new workflow: new · reviewed ·
 * planned · done · dismissed. The two terminal columns collapse by default
 * because they hold ~93% of the rows and none of the attention.
 *
 * Cards are deliberately thin — one glance each. Everything the old card showed
 * inline moved into a detail panel, which is also where status changes live, so
 * a card cannot be moved by accident while scanning.
 */

type Item = {
  id: string;
  project: string;
  category: string;
  summary: string;
  detail: string | null;
  toolName: string | null;
  evidence: { request: string; response: string; reproduction?: string } | null;
  verification: {
    claimedCodes: string[];
    unknownCodes: string[];
    toolKnown: boolean | null;
    platform: string;
    plugins: string[];
  } | null;
  status: string;
  when: string;
};

const CATEGORIES = ["all", "limitation", "bug", "friction", "idea"] as const;
const STATUSES = ["new", "reviewed", "planned", "done", "dismissed"] as const;
/** The terminal columns — collapsed by default; they are an archive, not a queue. */
const TERMINAL = new Set(["done", "dismissed"]);

const catColor: Record<string, string> = {
  limitation: "var(--color-warn, #a2650a)",
  bug: "var(--color-err, #b02a2a)",
  friction: "var(--color-accent, #0f766e)",
  idea: "var(--color-ok, #0e7c5f)",
};

// One hue per stage, used identically in the column header and on every card.
const statusColor: Record<string, string> = {
  new: "var(--color-warn, #d9a514)",
  reviewed: "#5aa9e6",
  planned: "#a78bfa",
  done: "var(--color-ok, #43de83)",
  dismissed: "#8a8f98",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric" });

/** Does this item look unverified? Surfaced on the card so it is visible while scanning. */
function flags(i: Item): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  if (i.category === "bug" && !i.evidence) out.push({ text: "no receipts", color: statusColor.new });
  if (i.verification?.unknownCodes.length) out.push({ text: "unknown code", color: "var(--color-err, #e24b4a)" });
  if (i.verification?.toolKnown === false) out.push({ text: "unknown tool", color: "var(--color-err, #e24b4a)" });
  return out;
}

export function FeedbackBoard({ items: initial }: { items: Item[] }) {
  const [items, setItems] = useState(initial);
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>("all");
  const [proj, setProj] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const projects = useMemo(() => [...new Set(items.map((i) => i.project))].sort(), [items]);
  const shown = useMemo(
    () => items.filter((i) => (cat === "all" || i.category === cat) && (proj === "all" || i.project === proj)),
    [items, cat, proj],
  );
  const byStatus = (s: string) => shown.filter((i) => i.status === s);
  const selected = openId ? items.find((i) => i.id === openId) ?? null : null;

  async function setStatus(id: string, status: (typeof STATUSES)[number]) {
    setBusy(id);
    const r = await setFeedbackStatusAction(id, status);
    setBusy(null);
    if (!r.error) setItems((all) => all.map((i) => (i.id === id ? { ...i, status } : i)));
  }

  async function bulkResolve(status: "done" | "dismissed") {
    const n = shown.filter((i) => !TERMINAL.has(i.status)).length;
    if (n === 0) return;
    if (!confirm(`Mark ${n} open ${cat === "all" ? "" : cat + " "}item(s) as ${status}?`)) return;
    setBusy("bulk");
    const r = await bulkResolveFeedbackAction(cat, status);
    setBusy(null);
    if (!r.error) {
      setItems((all) =>
        all.map((i) =>
          !TERMINAL.has(i.status) && (cat === "all" || i.category === cat) ? { ...i, status } : i,
        ),
      );
    }
  }

  const toggle = (s: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  // ---------------------------------------------------------------- card
  const Card = ({ i }: { i: Item }) => (
    <button
      type="button"
      onClick={() => setOpenId(i.id)}
      className={`w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-line-strong ${
        openId === i.id ? "border-line-strong" : "border-line"
      }`}
      style={{ borderLeft: `3px solid ${catColor[i.category] ?? "var(--color-line)"}` }}
    >
      <p className="m-0 line-clamp-2 text-[13px] font-medium leading-snug text-ink">{i.summary}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-ink-mute">
        <span className="truncate" style={{ color: catColor[i.category] }}>{i.category}</span>
        <span className="text-line-strong">·</span>
        <span className="truncate">{i.project}</span>
        <span className="ml-auto shrink-0 text-line-strong">{when(i.when)}</span>
      </div>
      {flags(i).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em]">
          {flags(i).map((f) => (
            <span key={f.text} style={{ color: f.color }}>⚠ {f.text}</span>
          ))}
        </div>
      )}
    </button>
  );

  // ---------------------------------------------------------------- column
  const Column = ({ s }: { s: string }) => {
    const list = byStatus(s);
    const isTerminal = TERMINAL.has(s);
    const open = !isTerminal || expanded.has(s);
    return (
      <div className={`flex min-h-0 flex-col ${open ? "w-[280px] shrink-0" : "w-[150px] shrink-0"}`}>
        <button
          type="button"
          onClick={() => isTerminal && toggle(s)}
          disabled={!isTerminal}
          className={`mb-2 flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 ${
            isTerminal ? "hover:border-line-strong" : "cursor-default"
          }`}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor[s] }} />
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink">{s}</span>
          <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-mute">{list.length}</span>
          {isTerminal && <span className="font-mono text-[10px] text-line-strong">{open ? "−" : "+"}</span>}
        </button>
        {open && (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
            {list.length === 0 ? (
              <p className="m-0 rounded-lg border border-dashed border-line px-3 py-4 text-center font-mono text-[10.5px] text-line-strong">
                empty
              </p>
            ) : (
              list.map((i) => <Card key={i.id} i={i} />)
            )}
          </div>
        )}
      </div>
    );
  };

  const openCount = shown.filter((i) => !TERMINAL.has(i.status)).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- filters ---- */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCat(c)}
            className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.08em] ${
              cat === c ? "border-line-strong bg-card text-ink" : "border-line text-ink-mute hover:border-line-strong"
            }`}
            style={cat === c && c !== "all" ? { color: catColor[c] } : undefined}
          >
            {c}
            {c !== "all" && <span className="ml-1.5 opacity-60">{items.filter((i) => i.category === c).length}</span>}
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
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-line-strong">
            {openCount} open{cat === "all" ? "" : ` (${cat})`}
          </span>
          <button
            type="button"
            disabled={busy === "bulk" || openCount === 0}
            onClick={() => bulkResolve("done")}
            className="btn btn-ghost text-xs disabled:opacity-40"
          >
            Resolve open
          </button>
          <button
            type="button"
            disabled={busy === "bulk" || openCount === 0}
            onClick={() => bulkResolve("dismissed")}
            className="btn btn-ghost text-xs disabled:opacity-40"
          >
            Dismiss open
          </button>
        </span>
      </div>

      {/* ---- board ---- */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {STATUSES.map((s) => (
          <Column key={s} s={s} />
        ))}
      </div>

      {/* ---- detail ---- */}
      {selected && (
        <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col border-l border-line bg-card shadow-2xl">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <div className="mb-1.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px]">
                <span
                  className="rounded-full px-2 py-0.5 uppercase tracking-[0.08em]"
                  style={{ color: catColor[selected.category], border: "1px solid currentColor" }}
                >
                  {selected.category}
                </span>
                <span className="text-ink-mute">{selected.project}</span>
                {selected.toolName && <span className="text-line-strong">· {selected.toolName}</span>}
                <span className="text-line-strong">· {when(selected.when)}</span>
              </div>
              <p className="m-0 text-[15px] font-semibold leading-snug text-ink">{selected.summary}</p>
            </div>
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="shrink-0 rounded-md px-2 py-0.5 text-ink-mute hover:text-ink"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {selected.detail && (
              <p className="m-0 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">{selected.detail}</p>
            )}

            {selected.evidence && (
              <div>
                <p className="m-0 mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-line-strong">Receipts</p>
                <div className="rounded-lg border border-line bg-paper p-3 font-mono text-[11px] leading-relaxed">
                  <div className="text-ink-mute">request</div>
                  <div className="whitespace-pre-wrap break-all">{selected.evidence.request}</div>
                  <div className="mt-2 text-ink-mute">response</div>
                  <div className="whitespace-pre-wrap break-all">{selected.evidence.response}</div>
                  {selected.evidence.reproduction && (
                    <>
                      <div className="mt-2 text-ink-mute">reproduction</div>
                      <div className="whitespace-pre-wrap">{selected.evidence.reproduction}</div>
                    </>
                  )}
                </div>
              </div>
            )}

            {selected.verification && (
              <div>
                <p className="m-0 mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-line-strong">
                  Verification
                </p>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.06em]">
                  {selected.category === "bug" && !selected.evidence && (
                    <span style={{ color: statusColor.new }}>⚠ no receipts</span>
                  )}
                  {selected.verification.unknownCodes.length > 0 ? (
                    <span style={{ color: "var(--color-err, #e24b4a)" }}>
                      ✗ unknown: {selected.verification.unknownCodes.join(", ")}
                    </span>
                  ) : (
                    selected.verification.claimedCodes.length > 0 && (
                      <span style={{ color: statusColor.done }}>✓ codes real</span>
                    )
                  )}
                  {selected.verification.toolKnown !== null && (
                    <span
                      style={{
                        color: selected.verification.toolKnown ? statusColor.done : "var(--color-err, #e24b4a)",
                      }}
                    >
                      {selected.verification.toolKnown ? "✓ tool real" : "✗ unknown tool"}
                    </span>
                  )}
                  <span className="text-ink-mute">platform {selected.verification.platform}</span>
                  {selected.verification.plugins.length > 0 && (
                    <span className="text-ink-mute" title={selected.verification.plugins.join(", ")}>
                      {selected.verification.plugins.length} plugin
                      {selected.verification.plugins.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Status lives here, not on the card — so nothing moves by mis-click while scanning. */}
          <div className="shrink-0 border-t border-line px-5 py-3">
            <p className="m-0 mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-line-strong">Move to</p>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy === selected.id}
                  onClick={() => setStatus(selected.id, s)}
                  className={`rounded px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.06em] disabled:opacity-40 ${
                    selected.status === s ? "bg-paper font-semibold" : "text-ink-mute hover:text-ink"
                  }`}
                  style={
                    selected.status === s
                      ? { color: statusColor[s], border: "1px solid currentColor" }
                      : { border: "1px solid transparent" }
                  }
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
