"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search, Users } from "lucide-react";
import type { ViewerWorkspace } from "@/lib/workspaces";

/**
 * The workspace switcher (B1c) — top of the sidebar on the dashboard. Picks the
 * active workspace; the fleet below scopes to it. Writes the ax_workspace cookie
 * and reloads, the same pattern as the theme toggle. Inside a project the slot
 * shows the project switcher instead.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeId,
}: {
  workspaces: ViewerWorkspace[];
  activeId: string;
}) {
  const router = useRouter();
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

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  const filtered = q ? workspaces.filter((w) => w.name.toLowerCase().includes(q.toLowerCase())) : workspaces;

  const select = (id: string) => {
    if (id !== activeId) {
      document.cookie = `ax_workspace=${id};path=/;max-age=31536000;samesite=lax`;
      router.push("/admin");
      router.refresh();
    }
    setOpen(false);
  };

  if (!active) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-raised"
      >
        <Tile name={active.name} />
        <span className="min-w-0 flex-1">
          <span className="display block truncate text-[13.5px] font-semibold text-ink">{active.name}</span>
          <span className="block font-mono text-[10px] text-line-strong">
            {active.projects} {active.projects === 1 ? "project" : "projects"} · {active.role}
          </span>
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-line-strong" />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 flex flex-col overflow-hidden rounded-lg border border-line bg-card"
          style={{ boxShadow: "0 16px 48px rgba(0,0,0,0.55)" }}
        >
          <p className="px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-line-strong">
            Workspaces
          </p>

          {workspaces.length > 6 && (
            <div className="flex items-center gap-2 border-y border-line px-3 py-2">
              <Search className="h-3.5 w-3.5 text-line-strong" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a workspace"
                className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-line-strong"
              />
            </div>
          )}

          <div className="max-h-[40vh] overflow-y-auto p-1">
            {filtered.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => select(w.id)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-raised"
              >
                <Tile name={w.name} sm />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{w.name}</span>
                  <span className="block font-mono text-[10px] text-line-strong">
                    {w.projects} · {w.role}
                  </span>
                </span>
                {w.id === activeId && <Check className="h-3.5 w-3.5" style={{ color: "var(--color-accent)" }} />}
              </button>
            ))}
          </div>

          <Link
            href="/admin/workspace"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 border-t border-line px-3 py-2.5 text-[13px] text-ink-mute transition-colors hover:bg-raised hover:text-ink"
          >
            <Users className="h-4 w-4" />
            Manage team
          </Link>
        </div>
      )}
    </div>
  );
}

function Tile({ name, sm = false }: { name: string; sm?: boolean }) {
  const s = sm ? 22 : 28;
  return (
    <span
      className="display grid shrink-0 place-items-center rounded-md bg-raised font-semibold text-ink-soft"
      style={{ width: s, height: s, fontSize: s * 0.42 }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
