import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { and, count, eq, isNull, inArray } from "drizzle-orm";
import { tenantDb } from "@/lib/data-plane";
import { entries } from "@/db/schema";
import { getProject } from "@/lib/admin";
import { getProjectRole, accessibleProjects, getViewer, hasTenantRung } from "@/lib/access";
import { latestSuspendNote, recordSupportAccess } from "@/lib/platform-events";
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

  // B4 support access: an operator with no tenant rung into this project is
  // here for support — banner them, and record the visit (deduped) where the
  // tenant can see it. Suspension shows its tenant-visible reason the same way.
  const supportAccess =
    viewer?.isPlatformOperator === true && !(await hasTenantRung(projectId, viewer));
  if (supportAccess && viewer) await recordSupportAccess(projectId, viewer.email);
  const suspendNote = project.status === "suspended" ? await latestSuspendNote(projectId) : null;

  const inboxIds = collections.filter((c) => c.publicWrite).map((c) => c.id);
  const unhandled =
    inboxIds.length === 0
      ? []
      : await (await tenantDb(projectId))
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
        {project.status === "suspended" && (
          <div
            className="mb-5 rounded-xl border px-4 py-3 text-[13px] leading-relaxed"
            style={{
              borderColor: "color-mix(in srgb, var(--color-err) 40%, transparent)",
              background: "color-mix(in srgb, var(--color-err) 8%, transparent)",
            }}
          >
            <p className="m-0 font-medium" style={{ color: "var(--color-err)" }}>
              This project is suspended by the platform operators — its agent and delivery APIs are dark.
            </p>
            <p className="m-0 mt-1 text-ink-mute">
              {suspendNote ? (
                <>
                  Reason: {suspendNote}.{" "}
                </>
              ) : null}
              Content and settings remain intact. Contact support to resolve it.
            </p>
          </div>
        )}
        {supportAccess && (
          <div className="mb-5 rounded-xl border border-line bg-card px-4 py-2.5 font-mono text-[11.5px] text-ink-mute">
            <span style={{ color: "var(--color-warn)" }}>support access</span> — you are a platform
            operator in a tenant&apos;s project. This visit is logged and visible to them in Settings.
          </div>
        )}
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
