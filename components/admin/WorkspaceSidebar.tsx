"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  Code2,
  Image as ImageIcon,
  LayoutGrid,
  Palette,
  Plug,
  Plus,
  Settings,
  Table2,
  Trash2,
  Users,
  X,
  Puzzle,
  MessageSquare,
} from "lucide-react";
import { useRail } from "./AdminShell";

/**
 * The left project/workspace rail — just the fixed nav now (identity, search,
 * profile and theme moved to the top bar). Collapses to an icon-only column on
 * desktop via the shell's rail context, and opens as a drawer on mobile. The
 * open-ended Content list still lives in its own right-docked panel.
 */
export function WorkspaceSidebar({
  currentId,
  canCreateProjects = false,
  isPlatformOperator = false,
}: {
  currentId?: string;
  /** LAUNCH-PLAN 0.1: creation is operator-only until B2 reopens it. */
  canCreateProjects?: boolean;
  /** B4: platform operators get the console link (the god view). */
  isPlatformOperator?: boolean;
}) {
  const pathname = usePathname();
  const { collapsed, mobileOpen, setMobileOpen } = useRail();
  useEffect(() => setMobileOpen(false), [pathname, setMobileOpen]);

  const inProject = Boolean(currentId);

  const item = (href: string, label: string, Icon: typeof Table2) => {
    const active = pathname === href || pathname.startsWith(href + "/");
    return (
      <Link
        key={href}
        href={href}
        title={collapsed ? label : undefined}
        className={`group relative flex items-center rounded-lg text-[13.5px] transition-colors ${
          collapsed ? "justify-center px-0 py-2 md:mx-auto md:w-9" : "gap-2.5 px-2.5 py-[7px]"
        } ${active ? "bg-raised font-medium text-ink" : "text-ink-mute hover:bg-raised hover:text-ink"}`}
      >
        {active && (
          <span
            className="absolute -left-2 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r"
            style={{ background: "var(--brand)" }}
          />
        )}
        <Icon className="h-4 w-4 shrink-0" style={active ? { color: "var(--brand)" } : undefined} />
        {!collapsed && <span className="truncate">{label}</span>}
      </Link>
    );
  };

  const group = (text: string) =>
    collapsed ? (
      <div className="mx-2 my-2 border-t border-line" />
    ) : (
      <p className="px-2.5 pb-1 pt-4 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-line-strong">
        {text}
      </p>
    );

  const nav = inProject ? (
    <>
      {group("Project")}
      {item(`/admin/${currentId}`, "Overview", LayoutGrid)}
      {item(`/admin/${currentId}/assets`, "Media", ImageIcon)}
      {item(`/admin/${currentId}/trash`, "Trash", Trash2)}
      {item(`/admin/${currentId}/plugins`, "Plugins", Puzzle)}
      {item(`/admin/${currentId}/appearance`, "Appearance", Palette)}
      {item(`/admin/${currentId}/connectors`, "Connectors", Plug)}
      {item(`/admin/${currentId}/api`, "API reference", Code2)}
      {item(`/admin/${currentId}/settings`, "Settings", Settings)}
    </>
  ) : (
    <>
      {group("Workspace")}
      {item("/admin", "Projects", LayoutGrid)}
      {item("/admin/workspace", "Team", Users)}
      {canCreateProjects && item("/admin/new", "New project", Plus)}
      {isPlatformOperator && (
        <>
          {group("Platform")}
          {item("/admin/console", "Console", Boxes)}
          {item("/admin/console/feedback", "Feedback", MessageSquare)}
          {item("/admin/console/plugins", "Plugins", Puzzle)}
        </>
      )}
    </>
  );

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-screen w-64 shrink-0 flex-col border-r border-line bg-card transition-all duration-200 md:sticky md:top-[52px] md:z-0 md:h-[calc(100vh-52px)] md:translate-x-0 ${
          collapsed ? "md:w-[60px]" : "md:w-64"
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        <div className="flex items-center justify-end border-b border-line px-2.5 py-2 md:hidden">
          <button type="button" onClick={() => setMobileOpen(false)} className="rounded-md p-1 text-ink-mute">
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className={`min-h-0 flex-1 overflow-y-auto py-2 ${collapsed ? "px-2" : "px-2.5"}`}>{nav}</nav>
      </aside>
    </>
  );
}
