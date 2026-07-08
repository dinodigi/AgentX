"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Code2, Image as ImageIcon, Inbox, Menu, Palette, Plug, Settings, Table2, Trash2 } from "lucide-react";

/**
 * The project workspace rail — ink-dark so the content area reads as paper and
 * the project's brand color is the only saturated voice. Renders entirely from
 * the schema registry: content collections, public-write inboxes, then the
 * project tabs (Appearance / Connectors / Settings / API).
 */

export interface SidebarCollection {
  name: string;
  displayName: string;
  publicWrite: boolean;
  /** Unhandled submissions (publicWrite collections only). */
  unhandled?: number;
}

export function Sidebar({
  projectId,
  projectName,
  logoUrl,
  collections,
}: {
  projectId: string;
  projectName: string;
  logoUrl?: string;
  collections: SidebarCollection[];
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Navigating closes the drawer (no-op on desktop where it isn't rendered).
  useEffect(() => setOpen(false), [pathname]);
  const content = collections.filter((c) => !c.publicWrite);
  const inbox = collections.filter((c) => c.publicWrite);

  const item = (href: string, label: string, Icon: typeof Table2, badge?: number) => {
    const active = pathname === href || pathname.startsWith(href + "/");
    return (
      <Link
        key={href}
        href={href}
        className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] transition-colors ${
          active
            ? "bg-white/[0.08] font-medium text-white"
            : "text-white/55 hover:bg-white/[0.05] hover:text-white/85"
        }`}
      >
        {active && (
          <span
            className="absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r"
            style={{ background: "var(--brand)" }}
          />
        )}
        <Icon
          className={`h-4 w-4 shrink-0 transition-colors ${active ? "" : "text-white/40 group-hover:text-white/70"}`}
          style={active ? { color: "var(--brand)" } : undefined}
        />
        <span className="truncate">{label}</span>
        {badge ? (
          <span
            className="ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
            style={{ background: "var(--brand)" }}
            title={`${badge} unhandled`}
          >
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </Link>
    );
  };

  const groupLabel = (text: string) => (
    <p className="px-2.5 pb-1.5 pt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">
      {text}
    </p>
  );

  return (
    <>
      {/* Mobile: hamburger + scrim; the rail itself slides in as a drawer. */}
      <button
        type="button"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
        className="fixed left-3 top-2.5 z-40 rounded-lg bg-[#16130e] p-2 text-white/80 shadow md:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 flex-col overflow-y-auto bg-[#16130e] px-3 py-4 transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
      <div className="mb-2 flex items-center gap-2.5 px-2.5">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-7 w-7 rounded-lg object-cover ring-1 ring-white/10" />
        ) : (
          <div
            className="display flex h-7 w-7 items-center justify-center rounded-lg text-[13px] font-semibold text-white"
            style={{ background: "var(--brand)" }}
          >
            {projectName.charAt(0).toUpperCase()}
          </div>
        )}
        <span className="display truncate text-[14.5px] font-semibold text-white">
          {projectName}
        </span>
      </div>

      {content.length > 0 && groupLabel("Content")}
      {content.map((c) => item(`/admin/${projectId}/${c.name}`, c.displayName, Table2))}

      {inbox.length > 0 && groupLabel("Inbox")}
      {inbox.map((c) => item(`/admin/${projectId}/${c.name}`, c.displayName, Inbox, c.unhandled))}

      {groupLabel("Project")}
      {item(`/admin/${projectId}/assets`, "Media", ImageIcon)}
      {item(`/admin/${projectId}/trash`, "Trash", Trash2)}
      {item(`/admin/${projectId}/appearance`, "Appearance", Palette)}
      {item(`/admin/${projectId}/connectors`, "Connectors", Plug)}
      {item(`/admin/${projectId}/api`, "API reference", Code2)}
      {item(`/admin/${projectId}/settings`, "Settings", Settings)}

      <Link
        href="/admin"
        className="mt-auto flex items-center gap-2 px-2.5 py-2 text-xs text-white/35 transition-colors hover:text-white/70"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All projects
      </Link>
      </aside>
    </>
  );
}
