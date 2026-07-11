import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { and, count, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { entries } from "@/db/schema";
import { getProject } from "@/lib/admin";
import { getProjectRole, accessibleProjects, getViewer } from "@/lib/access";
import { listCollections } from "@/lib/collections";
import { brandInk } from "@/lib/brand";
import { getWorkspaceTheme, getSidebarCollapsed } from "@/lib/theme";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { ContentSidebar } from "@/components/admin/ContentSidebar";
import type { SwitcherProject } from "@/components/admin/ProjectSwitcher";

/**
 * The project workspace shell — three columns: the left chrome rail (switcher +
 * fixed project sections + account), the editing area, and the right ContentSidebar
 * (collections + inboxes, the part that grows with the schema). --brand is the
 * single client color, contained; the theme is governed by the admin root above.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ projectId: string }>;
  children: ReactNode;
}) {
  const { projectId } = await params;
  const [project, collections, role, allProjects, theme, collapsed, viewer] = await Promise.all([
    getProject(projectId),
    listCollections(projectId),
    getProjectRole(projectId),
    accessibleProjects(),
    getWorkspaceTheme(),
    getSidebarCollapsed(),
    getViewer(),
  ]);
  if (!project || !role) notFound();

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

  return (
    <div
      className="flex min-h-screen"
      style={{ "--brand": brand, "--brand-ink": brandInk(brand) } as CSSProperties}
    >
      <WorkspaceSidebar
        projects={allProjects.map(toSwitcher)}
        currentId={projectId}
        theme={theme}
        canCreateProjects={viewer?.isPlatformOperator ?? false}
        isPlatformOperator={viewer?.isPlatformOperator ?? false}
      />
      <main className="page-enter mx-auto min-w-0 max-w-[1400px] flex-1 px-5 py-7 md:px-10 md:py-9">
        {children}
      </main>
      <ContentSidebar
        currentId={projectId}
        content={collections.map((c) => ({
          name: c.name,
          displayName: c.displayName,
          publicWrite: c.publicWrite,
          unhandled: unhandledById.get(c.id) ?? 0,
        }))}
        defaultCollapsed={collapsed}
      />
    </div>
  );
}

/** Only allow simple color tokens to avoid style injection. */
function safeColor(v: string | undefined): string {
  if (v && /^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  return "#4f46e5";
}

function toSwitcher(p: {
  id: string;
  name: string;
  branding: { displayName?: string; primaryColor?: string; logoUrl?: string };
}): SwitcherProject {
  const name = p.branding?.displayName ?? p.name;
  const brand = p.branding?.primaryColor ?? "#4f46e5";
  return {
    id: p.id,
    name,
    initial: name.charAt(0).toUpperCase(),
    brand,
    brandInk: brandInk(brand),
    logoUrl: p.branding?.logoUrl ?? null,
  };
}
