"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { ArrowLeft, Boxes, CornerDownLeft, LayoutGrid, Menu, PanelLeft, Plus, Search, X } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { projectIcon } from "./project-icons";
import type { SwitcherProject } from "./ProjectSwitcher";
import type { ViewerWorkspace } from "@/lib/workspaces";

/**
 * The admin shell (client): a unified top bar across every admin surface plus a
 * ⌘K command palette. Profile + theme live top-right; the left project rail
 * collapses to an icon-only column via a context the rail consumes. Wraps the
 * whole admin subtree from app/admin/layout — the per-route sidebars render
 * inside `children` and read the collapse state through this context.
 */

const RAIL_COOKIE = "ax_rail";

interface RailState {
  collapsed: boolean;
  toggle: () => void;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
}
const RailCtx = createContext<RailState>({
  collapsed: false,
  toggle: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
});
export const useRail = () => useContext(RailCtx);

export interface AdminShellData {
  theme: "dark" | "light";
  projects: SwitcherProject[];
  workspaces: ViewerWorkspace[];
  activeWorkspaceId?: string;
  isOperator: boolean;
  canCreate: boolean;
  defaultRailCollapsed: boolean;
}

export function AdminShell({ children, ...data }: AdminShellData & { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(data.defaultRailCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      document.cookie = `${RAIL_COOKIE}=${next ? "1" : "0"};path=/;max-age=31536000;samesite=lax`;
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <RailCtx.Provider value={{ collapsed, toggle, mobileOpen, setMobileOpen }}>
      <div className="flex min-h-screen flex-col">
        <TopBar
          {...data}
          onOpenPalette={() => setPaletteOpen(true)}
          onToggleRail={toggle}
          onOpenMobile={() => setMobileOpen(true)}
        />
        <div className="flex min-h-0 flex-1">{children}</div>
      </div>
      {paletteOpen && (
        <CommandPalette
          projects={data.projects}
          isOperator={data.isOperator}
          canCreate={data.canCreate}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </RailCtx.Provider>
  );
}

/* ── top bar ──────────────────────────────────────────────────────────── */

function TopBar({
  theme,
  projects,
  workspaces,
  activeWorkspaceId,
  onOpenPalette,
  onToggleRail,
  onOpenMobile,
}: AdminShellData & { onOpenPalette: () => void; onToggleRail: () => void; onOpenMobile: () => void }) {
  const pathname = usePathname();
  const seg = pathname.split("/")[2]; // /admin/<seg>
  const current = projects.find((p) => p.id === seg) ?? null;

  return (
    <header className="sticky top-0 z-40 flex h-[52px] shrink-0 items-center gap-2 border-b border-line bg-card px-3">
      <button
        type="button"
        onClick={onOpenMobile}
        aria-label="Open navigation"
        className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onToggleRail}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
        className="hidden rounded-md p-1.5 text-ink-mute transition-colors hover:bg-raised hover:text-ink md:inline-flex"
      >
        <PanelLeft className="h-4 w-4" />
      </button>

      {current ? (
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/admin"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] text-ink-mute transition-colors hover:bg-raised hover:text-ink"
            title="Back to dashboard"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
          <span className="text-line-strong">/</span>
          <MiniTile p={current} />
          <span className="display truncate text-[13.5px] font-semibold text-ink">{current.name}</span>
        </div>
      ) : workspaces.length > 0 ? (
        <div className="w-[220px] max-w-[52vw]">
          <WorkspaceSwitcher workspaces={workspaces} activeId={activeWorkspaceId ?? workspaces[0].id} />
        </div>
      ) : (
        <span className="font-mono text-[12px] text-line-strong">agentx</span>
      )}

      {/* ⌘K search trigger */}
      <button
        type="button"
        onClick={onOpenPalette}
        className="ml-auto inline-flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-ink-mute transition-colors hover:border-line-strong hover:text-ink"
        title="Search projects (⌘K)"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden text-[12px] sm:inline">Search</span>
        <kbd className="hidden rounded border border-line px-1 font-mono text-[10px] text-line-strong md:inline">⌘K</kbd>
      </button>

      <ThemeToggle initial={theme} />
      <UserButton appearance={{ elements: { userButtonAvatarBox: "h-6 w-6" } }} />
    </header>
  );
}

function MiniTile({ p }: { p: SwitcherProject }) {
  const Icon = projectIcon(p.icon);
  if (p.logoUrl && !p.icon) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={p.logoUrl} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover" />;
  }
  return (
    <span
      className="display grid h-6 w-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold"
      style={{ background: p.brand, color: p.brandInk }}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" strokeWidth={2} /> : p.initial}
    </span>
  );
}

/* ── ⌘K command palette ───────────────────────────────────────────────── */

type PaletteItem =
  | { kind: "action"; label: string; href: string; icon: typeof LayoutGrid }
  | { kind: "project"; label: string; href: string; project: SwitcherProject };

function CommandPalette({
  projects,
  isOperator,
  canCreate,
  onClose,
}: {
  projects: SwitcherProject[];
  isOperator: boolean;
  canCreate: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { kind: "action", label: "All projects", href: "/admin", icon: LayoutGrid },
    ];
    if (isOperator) actions.push({ kind: "action", label: "Operator console", href: "/admin/console", icon: Boxes });
    if (canCreate) actions.push({ kind: "action", label: "New project", href: "/admin/new", icon: Plus });
    const projItems: PaletteItem[] = projects.map((p) => ({
      kind: "project",
      label: p.name,
      href: `/admin/${p.id}`,
      project: p,
    }));
    const all = [...actions, ...projItems];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((i) => i.label.toLowerCase().includes(needle)) : all;
  }, [projects, isOperator, canCreate, q]);

  useEffect(() => setActive(0), [q]);

  const go = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      onClose();
      router.push(item.href);
    },
    [onClose, router],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-line bg-card"
        style={{ boxShadow: "0 24px 64px rgba(0,0,0,0.6)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-line-strong" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a project or page…"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-line-strong"
          />
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-line-strong hover:text-ink-mute">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-mute">No matches.</p>
          ) : (
            items.map((item, i) => (
              <button
                key={item.href}
                type="button"
                data-idx={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(item)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  i === active ? "bg-raised" : "hover:bg-raised"
                }`}
              >
                {item.kind === "project" ? (
                  <MiniTile p={item.project} />
                ) : (
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-raised text-ink-mute">
                    <item.icon className="h-3.5 w-3.5" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{item.label}</span>
                {item.kind === "action" && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-line-strong">page</span>
                )}
                {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-line-strong" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
