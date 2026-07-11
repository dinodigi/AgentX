"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import {
  Boxes,
  Code2,
  Image as ImageIcon,
  LayoutGrid,
  Menu,
  Palette,
  Plug,
  Plus,
  Settings,
  Table2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { ProjectSwitcher, type SwitcherProject } from "./ProjectSwitcher";

/**
 * The left workspace rail (studio + project chrome). A bounded set — switcher,
 * the fixed project sections, account — so it never scrolls or collapses. The
 * open-ended Content list lives in its own right-docked panel (ContentSidebar).
 */
export function WorkspaceSidebar({
  projects,
  currentId,
  theme,
  canCreateProjects = false,
  isPlatformOperator = false,
}: {
  projects: SwitcherProject[];
  currentId?: string;
  theme: "dark" | "light";
  /** LAUNCH-PLAN 0.1: creation is operator-only until B2 reopens it. */
  canCreateProjects?: boolean;
  /** B4: platform operators get the console link (the god view). */
  isPlatformOperator?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const inProject = Boolean(currentId);

  const item = (href: string, label: string, Icon: typeof Table2) => {
    const active = pathname === href || pathname.startsWith(href + "/");
    return (
      <Link
        key={href}
        href={href}
        className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] transition-colors ${
          active ? "bg-raised font-medium text-ink" : "text-ink-mute hover:bg-raised hover:text-ink"
        }`}
      >
        {active && (
          <span
            className="absolute -left-2 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r"
            style={{ background: "var(--brand)" }}
          />
        )}
        <Icon className="h-4 w-4 shrink-0" style={active ? { color: "var(--brand)" } : undefined} />
        <span className="truncate">{label}</span>
      </Link>
    );
  };

  const group = (text: string) => (
    <p className="px-2.5 pb-1 pt-4 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-line-strong">
      {text}
    </p>
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
        className={`fixed inset-y-0 left-0 z-50 flex h-screen w-64 shrink-0 flex-col border-r border-line bg-card transition-transform duration-200 md:sticky md:top-0 md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* PINNED: switcher */}
        <div className="flex items-center gap-1 border-b border-line p-2.5">
          <div className="min-w-0 flex-1">
            <ProjectSwitcher projects={projects} currentId={currentId} canCreate={canCreateProjects} />
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md p-1 text-ink-mute md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {inProject ? (
          <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
            {group("Project")}
            {item(`/admin/${currentId}`, "Overview", LayoutGrid)}
            {item(`/admin/${currentId}/assets`, "Media", ImageIcon)}
            {item(`/admin/${currentId}/trash`, "Trash", Trash2)}
            {item(`/admin/${currentId}/appearance`, "Appearance", Palette)}
            {item(`/admin/${currentId}/connectors`, "Connectors", Plug)}
            {item(`/admin/${currentId}/api`, "API reference", Code2)}
            {item(`/admin/${currentId}/settings`, "Settings", Settings)}
          </nav>
        ) : (
          <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
            {group("Workspace")}
            {item("/admin", "Projects", LayoutGrid)}
            {item("/admin/workspace", "Team", Users)}
            {canCreateProjects && item("/admin/new", "New project", Plus)}
            {isPlatformOperator && (
              <>
                {group("Platform")}
                {item("/admin/console", "Console", Boxes)}
              </>
            )}
          </nav>
        )}

        {/* PINNED: theme + account */}
        <div className="flex items-center justify-between border-t border-line px-3 py-2.5">
          <span className="font-mono text-[10px] text-line-strong">agentx</span>
          <div className="flex items-center gap-1.5">
            <ThemeToggle initial={theme} />
            <UserButton appearance={{ elements: { userButtonAvatarBox: "h-6 w-6" } }} />
          </div>
        </div>
      </aside>
    </>
  );
}
