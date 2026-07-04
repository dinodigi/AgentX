"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Code2, Inbox, Settings, Table2 } from "lucide-react";

/**
 * The project workspace sidebar. Renders entirely from the schema registry:
 * content collections, then public-write collections grouped as an inbox,
 * then the generated API reference and settings.
 */

export interface SidebarCollection {
  name: string;
  displayName: string;
  publicWrite: boolean;
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
  const content = collections.filter((c) => !c.publicWrite);
  const inbox = collections.filter((c) => c.publicWrite);

  const itemClass = (href: string) => {
    const active = pathname === href || pathname.startsWith(href + "/");
    return `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
      active
        ? "bg-brand-soft text-brand-strong font-medium"
        : "text-gray-600 hover:bg-gray-100"
    }`;
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-gray-50 p-3">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-6 w-6 rounded-md object-cover" />
        ) : (
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-brand text-xs font-medium text-white">
            {projectName.charAt(0).toUpperCase()}
          </div>
        )}
        <span className="truncate text-sm font-medium">{projectName}</span>
      </div>

      {content.length > 0 && (
        <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
          Content
        </p>
      )}
      {content.map((c) => (
        <Link key={c.name} href={`/admin/${projectId}/${c.name}`} className={itemClass(`/admin/${projectId}/${c.name}`)}>
          <Table2 className="h-4 w-4 shrink-0" />
          <span className="truncate">{c.displayName}</span>
        </Link>
      ))}

      {inbox.length > 0 && (
        <p className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
          Inbox
        </p>
      )}
      {inbox.map((c) => (
        <Link key={c.name} href={`/admin/${projectId}/${c.name}`} className={itemClass(`/admin/${projectId}/${c.name}`)}>
          <Inbox className="h-4 w-4 shrink-0" />
          <span className="truncate">{c.displayName}</span>
        </Link>
      ))}

      <div className="my-3 border-t border-gray-200" />
      <Link href={`/admin/${projectId}/api`} className={itemClass(`/admin/${projectId}/api`)}>
        <Code2 className="h-4 w-4 shrink-0" />
        API reference
      </Link>
      <Link href={`/admin/${projectId}/settings`} className={itemClass(`/admin/${projectId}/settings`)}>
        <Settings className="h-4 w-4 shrink-0" />
        Settings
      </Link>

      <Link
        href="/admin"
        className="mt-auto flex items-center gap-2 px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All projects
      </Link>
    </aside>
  );
}
