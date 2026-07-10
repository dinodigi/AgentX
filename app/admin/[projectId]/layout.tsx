import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { and, count, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { entries } from "@/db/schema";
import { getProject } from "@/lib/admin";
import { getProjectRole } from "@/lib/access";
import { listCollections } from "@/lib/collections";
import { brandInk } from "@/lib/brand";
import { Sidebar } from "@/components/Sidebar";

/**
 * The branded workspace shell. The per-project --brand CSS variable set here is
 * the single client color in the room — CONTAINED as a fill only; --brand-ink
 * is its luminance-safe text color. data-theme paints the shell (dark default),
 * so the admin can flip to a per-project light register without touching pages.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ projectId: string }>;
  children: ReactNode;
}) {
  const { projectId } = await params;
  const [project, collections, role] = await Promise.all([
    getProject(projectId),
    listCollections(projectId),
    getProjectRole(projectId),
  ]);
  // No access reads as not-found: don't leak which project ids exist.
  if (!project || !role) notFound();

  // Unhandled inbox counts (one grouped query across all publicWrite collections).
  const inboxIds = collections.filter((c) => c.publicWrite).map((c) => c.id);
  const unhandled =
    inboxIds.length === 0
      ? []
      : await db
          .select({ collectionId: entries.collectionId, n: count() })
          .from(entries)
          .where(and(inArray(entries.collectionId, inboxIds), isNull(entries.handledAt)))
          .groupBy(entries.collectionId);
  const unhandledById = new Map(unhandled.map((u) => [u.collectionId, u.n]));

  const brand = safeColor(project.branding.primaryColor);
  const displayName = project.branding.displayName ?? project.name;
  const theme = project.branding.theme === "light" ? "light" : "dark";

  return (
    <div
      className="flex min-h-screen bg-[--color-paper] text-[--color-ink]"
      data-theme={theme}
      style={{ "--brand": brand, "--brand-ink": brandInk(brand) } as CSSProperties}
    >
      <Sidebar
        projectId={projectId}
        projectName={displayName}
        logoUrl={project.branding.logoUrl}
        collections={collections.map((c) => ({
          name: c.name,
          displayName: c.displayName,
          publicWrite: c.publicWrite,
          unhandled: unhandledById.get(c.id) ?? 0,
        }))}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[--color-line] py-3 pl-14 pr-4 md:px-8">
          <span className="eyebrow">{displayName}</span>
          <UserButton />
        </header>
        <main className="page-enter mx-auto w-full max-w-4xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/** Only allow simple color tokens to avoid style injection. */
function safeColor(v: string | undefined): string {
  if (v && /^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  return "#4f46e5";
}
