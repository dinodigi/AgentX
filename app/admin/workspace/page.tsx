import { redirect } from "next/navigation";
import { accessibleProjects, getViewer } from "@/lib/access";
import { brandInk } from "@/lib/brand";
import { getWorkspaceTheme } from "@/lib/theme";
import {
  ensurePersonalWorkspace,
  getWorkspace,
  getWorkspaceRole,
  listWorkspaceMembers,
} from "@/lib/workspaces";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { WorkspaceTeam } from "@/components/admin/WorkspaceTeam";
import type { SwitcherProject } from "@/components/admin/ProjectSwitcher";

/**
 * The workspace/team page (B1b) — manage who belongs to your workspace and at
 * what role. Framed by the same studio shell as the project fleet.
 */
export default async function WorkspacePage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");

  const workspaceId = await ensurePersonalWorkspace(viewer);
  const [workspace, members, theme, projects] = await Promise.all([
    getWorkspace(workspaceId),
    listWorkspaceMembers(workspaceId),
    getWorkspaceTheme(),
    accessibleProjects(),
  ]);
  const role = viewer.isPlatformOperator ? "owner" : await getWorkspaceRole(workspaceId, viewer.userId);
  const canManage = viewer.isPlatformOperator || role === "owner" || role === "admin";
  const isOwner = viewer.isPlatformOperator || role === "owner";

  const switcher: SwitcherProject[] = projects.map((p) => {
    const name = p.branding?.displayName ?? p.name;
    const brand = p.branding?.primaryColor ?? "#4f46e5";
    return { id: p.id, name, initial: name.charAt(0).toUpperCase(), brand, brandInk: brandInk(brand), logoUrl: p.branding?.logoUrl ?? null };
  });

  return (
    <div className="flex min-h-screen">
      <WorkspaceSidebar projects={switcher} theme={theme} canCreateProjects={viewer.isPlatformOperator} />
      <div className="page-enter min-w-0 flex-1">
        <WorkspaceTeam
          workspaceId={workspaceId}
          name={workspace?.name ?? "Workspace"}
          members={members}
          canManage={canManage}
          isOwner={isOwner}
        />
      </div>
    </div>
  );
}
