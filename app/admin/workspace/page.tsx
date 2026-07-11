import { redirect } from "next/navigation";
import { getViewer } from "@/lib/access";
import { getWorkspaceTheme } from "@/lib/theme";
import { getActiveWorkspace, listViewerWorkspaces, listWorkspaceMembers } from "@/lib/workspaces";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { WorkspaceTeam } from "@/components/admin/WorkspaceTeam";

/**
 * The workspace/team page (B1b) — manage who belongs to the ACTIVE workspace
 * (B1c) and at what role. Framed by the same studio shell as the project fleet.
 */
export default async function WorkspacePage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");

  const active = await getActiveWorkspace(viewer);
  const [members, workspaces, theme] = await Promise.all([
    listWorkspaceMembers(active.id),
    listViewerWorkspaces(viewer.userId),
    getWorkspaceTheme(),
  ]);
  const canManage = viewer.isPlatformOperator || active.role === "owner" || active.role === "admin";
  const isOwner = viewer.isPlatformOperator || active.role === "owner";

  return (
    <div className="flex min-h-screen">
      <WorkspaceSidebar
        projects={[]}
        theme={theme}
        canCreateProjects={viewer.isPlatformOperator}
        isPlatformOperator={viewer.isPlatformOperator}
        workspaces={workspaces}
        activeWorkspaceId={active.id}
      />
      <div className="page-enter min-w-0 flex-1">
        <WorkspaceTeam
          workspaceId={active.id}
          name={active.name}
          members={members}
          canManage={canManage}
          isOwner={isOwner}
        />
      </div>
    </div>
  );
}
