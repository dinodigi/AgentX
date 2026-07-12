import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getViewer, accessibleProjects } from "@/lib/access";
import { getWorkspaceTheme, getRailCollapsed } from "@/lib/theme";
import { getActiveWorkspace, listViewerWorkspaces } from "@/lib/workspaces";
import { brandInk } from "@/lib/brand";
import { AdminShell } from "@/components/admin/AdminShell";
import type { SwitcherProject } from "@/components/admin/ProjectSwitcher";

/**
 * Admin shell root. Stamps the theme register (no flash) and mounts the unified
 * top bar + ⌘K palette + rail-collapse context around every admin surface. The
 * per-route sidebars render inside {children} and consume the collapse context.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");

  const [theme, railCollapsed, projects, workspaceList, active] = await Promise.all([
    getWorkspaceTheme(),
    getRailCollapsed(),
    accessibleProjects(),
    listViewerWorkspaces(viewer.userId),
    getActiveWorkspace(viewer),
  ]);

  const workspaces = workspaceList.some((w) => w.id === active.id) ? workspaceList : [active, ...workspaceList];
  const canCreate = viewer.isPlatformOperator || active.role === "owner" || active.role === "admin";

  const switcherProjects: SwitcherProject[] = projects.map((p) => {
    const name = p.branding?.displayName ?? p.name;
    const brand = p.branding?.primaryColor ?? "#4f46e5";
    return {
      id: p.id,
      name,
      initial: name.charAt(0).toUpperCase(),
      brand,
      brandInk: brandInk(brand),
      icon: p.branding?.icon ?? null,
      logoUrl: p.branding?.logoUrl ?? null,
    };
  });

  return (
    <div data-theme-root data-theme={theme} className="min-h-screen bg-paper text-ink">
      <AdminShell
        theme={theme}
        projects={switcherProjects}
        workspaces={workspaces}
        activeWorkspaceId={active.id}
        isOperator={viewer.isPlatformOperator}
        canCreate={canCreate}
        defaultRailCollapsed={railCollapsed}
      >
        {children}
      </AdminShell>
    </div>
  );
}
