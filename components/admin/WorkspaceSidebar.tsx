"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import {
  ChevronRight,
  Code2,
  Image as ImageIcon,
  Inbox,
  LayoutGrid,
  Menu,
  Palette,
  PanelLeftClose,
  Plug,
  Plus,
  Settings,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { ProjectSwitcher, type SwitcherProject } from "./ProjectSwitcher";

/**
 * The one workspace rail (studio + project). Layout that survives a big schema:
 * the Project section is PINNED so settings/media/etc. are always one click away,
 * and only the Content/Inbox list scrolls — with a foldable Content group for
 * projects with many collections. Collapses to an icon rail on desktop.
 */
export interface SidebarCollection {
  name: string;
  displayName: string;
  publicWrite: boolean;
  unhandled?: number;
}

export function WorkspaceSidebar({
  projects,
  currentId,
  content,
  theme,
  defaultCollapsed = false,
}: {
  projects: SwitcherProject[];
  currentId?: string;
  content?: SidebarCollection[];
  theme: "dark" | "light";
  defaultCollapsed?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [foldContent, setFoldContent] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  // Fold state is a minor nicety — read from localStorage after mount.
  useEffect(() => {
    if (currentId && localStorage.getItem(`ax_fold_${currentId}`) === "1") setFoldContent(true);
  }, [currentId]);

  const inProject = Boolean(currentId);
  const collections = (content ?? []).filter((c) => !c.publicWrite);
  const inbox = (content ?? []).filter((c) => c.publicWrite);
  const current = projects.find((p) => p.id === currentId);
  const compact = inProject && collapsed && !open;

  const setRailCollapsed = (v: boolean) => {
    setCollapsed(v);
    document.cookie = `ax_sidebar=${v ? "1" : "0"};path=/;max-age=31536000;samesite=lax`;
  };
  const toggleFold = () => {
    const next = !foldContent;
    setFoldContent(next);
    if (currentId) localStorage.setItem(`ax_fold_${currentId}`, next ? "1" : "0");
  };

  const item = (href: string, label: string, Icon: typeof Table2, badge?: number) => {
    const active = pathname === href || pathname.startsWith(href + "/");
    if (compact) {
      return (
        <Link
          key={href}
          href={href}
          title={badge ? `${label} · ${badge} unhandled` : label}
          className={`group relative flex h-9 items-center justify-center rounded-lg transition-colors ${
            active ? "bg-raised text-ink" : "text-ink-mute hover:bg-raised hover:text-ink"
          }`}
        >
          {active && (
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r" style={{ background: "var(--brand)" }} />
          )}
          <Icon className="h-[18px] w-[18px]" style={active ? { color: "var(--brand)" } : undefined} />
          {badge ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full" style={{ background: "var(--brand)" }} /> : null}
        </Link>
      );
    }
    return (
      <Link
        key={href}
        href={href}
        className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] transition-colors ${
          active ? "bg-raised font-medium text-ink" : "text-ink-mute hover:bg-raised hover:text-ink"
        }`}
      >
        {active && (
          <span className="absolute -left-2 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r" style={{ background: "var(--brand)" }} />
        )}
        <Icon className="h-4 w-4 shrink-0" style={active ? { color: "var(--brand)" } : undefined} />
        <span className="truncate">{label}</span>
        {badge ? (
          <span className="ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none" style={{ background: "var(--brand)", color: "var(--brand-ink)" }}>
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </Link>
    );
  };

  const staticGroup = (text: string) =>
    compact ? (
      <div className="mx-2 my-2 h-px bg-line" />
    ) : (
      <p className="px-2.5 pb-1 pt-4 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-line-strong">{text}</p>
    );

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
        className="fixed left-3 top-2.5 z-40 rounded-lg border border-line bg-card p-2 text-ink-mute md:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>
      {open && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-screen shrink-0 flex-col border-r border-line bg-card transition-[transform,width] duration-200 md:sticky md:top-0 md:translate-x-0 ${
          compact ? "w-14" : "w-64"
        } ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        {/* PINNED: switcher / expand */}
        {compact ? (
          <div className="flex flex-col items-center gap-2 border-b border-line py-2.5">
            <button
              type="button"
              onClick={() => setRailCollapsed(false)}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="grid h-8 w-8 place-items-center rounded-md border border-line text-ink-mute transition-colors hover:border-line-strong hover:text-ink"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            {current && (
              <Link
                href={`/admin/${currentId}`}
                title={current.name}
                className="display grid h-8 w-8 place-items-center rounded-md text-[13px] font-semibold"
                style={{ background: current.brand, color: current.brandInk }}
              >
                {current.initial}
              </Link>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1 border-b border-line p-2.5">
            <div className="min-w-0 flex-1">
              <ProjectSwitcher projects={projects} currentId={currentId} />
            </div>
            {inProject && (
              <button
                type="button"
                onClick={() => setRailCollapsed(true)}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                className="hidden rounded-md p-1.5 text-ink-mute transition-colors hover:bg-raised hover:text-ink md:inline-flex"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-ink-mute md:hidden">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {inProject ? (
          <>
            {/* SCROLL: content types — the part that grows without bound */}
            <div className={`min-h-0 flex-1 overflow-y-auto py-2 ${compact ? "flex flex-col gap-0.5 px-2" : "px-2.5"}`}>
              {compact ? (
                <>
                  {collections.map((c) => item(`/admin/${currentId}/${c.name}`, c.displayName, Table2))}
                  {inbox.map((c) => item(`/admin/${currentId}/${c.name}`, c.displayName, Inbox, c.unhandled))}
                </>
              ) : (
                <>
                  {collections.length > 0 && (
                    <button
                      type="button"
                      onClick={toggleFold}
                      className="flex w-full items-center gap-1.5 px-2.5 pb-1 pt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-line-strong transition-colors hover:text-ink-mute"
                    >
                      <ChevronRight className={`h-3 w-3 transition-transform ${foldContent ? "" : "rotate-90"}`} />
                      Content
                      <span className="ml-auto normal-case tracking-normal">{collections.length}</span>
                    </button>
                  )}
                  {!foldContent && collections.map((c) => item(`/admin/${currentId}/${c.name}`, c.displayName, Table2))}
                  {inbox.length > 0 && staticGroup("Inbox")}
                  {inbox.map((c) => item(`/admin/${currentId}/${c.name}`, c.displayName, Inbox, c.unhandled))}
                </>
              )}
            </div>

            {/* PINNED: project section — always reachable, never scrolls away */}
            <div className={`shrink-0 border-t border-line py-2 ${compact ? "flex flex-col gap-0.5 px-2" : "px-2.5"}`}>
              {item(`/admin/${currentId}`, "Overview", LayoutGrid)}
              {item(`/admin/${currentId}/assets`, "Media", ImageIcon)}
              {item(`/admin/${currentId}/trash`, "Trash", Trash2)}
              {item(`/admin/${currentId}/appearance`, "Appearance", Palette)}
              {item(`/admin/${currentId}/connectors`, "Connectors", Plug)}
              {item(`/admin/${currentId}/api`, "API reference", Code2)}
              {item(`/admin/${currentId}/settings`, "Settings", Settings)}
            </div>
          </>
        ) : (
          <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
            {staticGroup("Workspace")}
            {item("/admin", "Projects", LayoutGrid)}
            {item("/admin/new", "New project", Plus)}
          </nav>
        )}

        {/* PINNED: theme + account */}
        <div className={`border-t border-line ${compact ? "flex flex-col items-center gap-2 py-3" : "flex items-center justify-between px-3 py-2.5"}`}>
          {!compact && <span className="font-mono text-[10px] text-line-strong">agentx</span>}
          <div className={compact ? "flex flex-col items-center gap-2" : "flex items-center gap-1.5"}>
            <ThemeToggle initial={theme} />
            <UserButton appearance={{ elements: { userButtonAvatarBox: "h-6 w-6" } }} />
          </div>
        </div>
      </aside>
    </>
  );
}
