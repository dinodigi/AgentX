"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, LayoutList, PanelRightClose, PanelRightOpen, Table2, X } from "lucide-react";

/**
 * The content panel, docked on the right. Everything that grows with a client's
 * schema — collections and public-write inboxes — lives here on its own scroll,
 * separate from the bounded project chrome on the left. Collapses to a thin
 * reopen strip (no icon-only rail: identical grid icons are unreadable), and
 * opens as a right drawer on mobile.
 */
export interface SidebarCollection {
  name: string;
  displayName: string;
  publicWrite: boolean;
  unhandled?: number;
}

export function ContentSidebar({
  currentId,
  content,
  defaultCollapsed = false,
}: {
  currentId: string;
  content: SidebarCollection[];
  defaultCollapsed?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(defaultCollapsed); // desktop
  useEffect(() => setOpen(false), [pathname]);

  const collections = content.filter((c) => !c.publicWrite);
  const inbox = content.filter((c) => c.publicWrite);
  const totalUnhandled = inbox.reduce((n, c) => n + (c.unhandled ?? 0), 0);

  const setColl = (v: boolean) => {
    setCollapsed(v);
    document.cookie = `ax_sidebar=${v ? "1" : "0"};path=/;max-age=31536000;samesite=lax`;
  };

  const item = (c: SidebarCollection, Icon: typeof Table2) => {
    const href = `/admin/${currentId}/${c.name}`;
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
        <span className="truncate">{c.displayName}</span>
        {c.unhandled ? (
          <span
            className="ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none"
            style={{ background: "var(--brand)", color: "var(--brand-ink)" }}
          >
            {c.unhandled > 99 ? "99+" : c.unhandled}
          </span>
        ) : null}
      </Link>
    );
  };

  const group = (text: string) => (
    <p className="px-2.5 pb-1 pt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-line-strong">
      {text}
    </p>
  );

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
      {collections.length > 0 && group("Collections")}
      {collections.map((c) => item(c, Table2))}
      {inbox.length > 0 && group("Inbox")}
      {inbox.map((c) => item(c, Inbox))}
      {content.length === 0 && (
        <p className="px-2.5 py-6 text-[12.5px] leading-relaxed text-ink-mute">
          No content types yet. Your agent defines them over MCP.
        </p>
      )}
    </div>
  );

  const heading = (
    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-line-strong">
      Content
    </span>
  );

  return (
    <>
      {/* MOBILE: toggle + drawer */}
      <button
        type="button"
        aria-label="Open content"
        onClick={() => setOpen(true)}
        className="fixed right-3 top-2.5 z-40 rounded-lg border border-line bg-card p-2 text-ink-mute md:hidden"
      >
        <LayoutList className="h-4 w-4" />
        {totalUnhandled > 0 && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full" style={{ background: "var(--brand)" }} />
        )}
      </button>
      {open && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex h-screen w-64 flex-col border-l border-line bg-card transition-transform duration-200 md:hidden ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          {heading}
          <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-ink-mute">
            <X className="h-4 w-4" />
          </button>
        </div>
        {body}
      </aside>

      {/* DESKTOP: expanded panel or collapsed strip */}
      {collapsed ? (
        <aside className="sticky top-0 hidden h-screen w-11 shrink-0 flex-col items-center gap-3 border-l border-line bg-card py-3 md:flex">
          <button
            type="button"
            onClick={() => setColl(false)}
            aria-label="Show content"
            title="Show content"
            className="grid h-8 w-8 place-items-center rounded-md border border-line text-ink-mute transition-colors hover:border-line-strong hover:text-ink"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
          <div className="relative flex-1">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.2em] text-line-strong"
              style={{ writingMode: "vertical-rl" }}
            >
              Content
            </span>
            {totalUnhandled > 0 && (
              <span className="absolute -left-1 top-0 h-1.5 w-1.5 rounded-full" style={{ background: "var(--brand)" }} />
            )}
          </div>
        </aside>
      ) : (
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-l border-line bg-card md:flex">
          <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
            {heading}
            <button
              type="button"
              onClick={() => setColl(true)}
              aria-label="Collapse content"
              title="Collapse content"
              className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-raised hover:text-ink"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          {body}
        </aside>
      )}
    </>
  );
}
