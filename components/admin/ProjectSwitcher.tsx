"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, LayoutGrid, Plus, Search } from "lucide-react";

/**
 * The workspace switcher — pinned at the top of the sidebar so switching
 * projects or returning to "all projects" is always one click, from anywhere.
 * This is what makes the admin feel like a workspace rather than a set of pages.
 */
export interface SwitcherProject {
  id: string;
  name: string;
  initial: string;
  brand: string;
  brandInk: string;
  logoUrl?: string | null;
}

export function ProjectSwitcher({
  projects,
  currentId,
  canCreate = false,
}: {
  projects: SwitcherProject[];
  currentId?: string;
  /** LAUNCH-PLAN 0.1: creation is operator-only until B2 reopens it. */
  canCreate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = projects.find((p) => p.id === currentId);
  const filtered = q ? projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : projects;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-raised"
      >
        {current ? (
          <Tile p={current} />
        ) : (
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-raised text-ink-mute">
            <LayoutGrid className="h-4 w-4" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="display block truncate text-[13.5px] font-semibold text-ink">
            {current ? current.name : "All projects"}
          </span>
          <span className="block font-mono text-[10px] text-line-strong">
            {current ? "workspace" : `${projects.length} projects`}
          </span>
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-line-strong" />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 flex flex-col overflow-hidden rounded-lg border border-line bg-card"
          style={{ boxShadow: "0 16px 48px rgba(0,0,0,0.55)" }}
        >
          <Link
            href="/admin"
            onClick={() => setOpen(false)}
            className={`flex items-center gap-2.5 px-3 py-2.5 text-[13px] transition-colors hover:bg-raised ${
              !currentId ? "text-ink" : "text-ink-mute"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
            All projects
            {!currentId && <Check className="ml-auto h-3.5 w-3.5" style={{ color: "var(--color-accent)" }} />}
          </Link>

          {projects.length > 6 && (
            <div className="flex items-center gap-2 border-y border-line px-3 py-2">
              <Search className="h-3.5 w-3.5 text-line-strong" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a project"
                className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-line-strong"
              />
            </div>
          )}

          <div className="max-h-[40vh] overflow-y-auto border-t border-line p-1">
            {filtered.map((p) => (
              <Link
                key={p.id}
                href={`/admin/${p.id}`}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-raised"
              >
                <Tile p={p} sm />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{p.name}</span>
                {p.id === currentId && <Check className="h-3.5 w-3.5" style={{ color: "var(--color-accent)" }} />}
              </Link>
            ))}
          </div>

          {canCreate && (
            <Link
              href="/admin/new"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 border-t border-line px-3 py-2.5 text-[13px] text-ink-mute transition-colors hover:bg-raised hover:text-ink"
            >
              <Plus className="h-4 w-4" />
              New project
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Tile({ p, sm = false }: { p: SwitcherProject; sm?: boolean }) {
  const s = sm ? 22 : 28;
  if (p.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={p.logoUrl} alt="" className="shrink-0 rounded-md object-cover" style={{ width: s, height: s }} />;
  }
  return (
    <span
      className="display grid shrink-0 place-items-center rounded-md font-semibold"
      style={{ width: s, height: s, background: p.brand, color: p.brandInk, fontSize: s * 0.42 }}
    >
      {p.initial}
    </span>
  );
}
