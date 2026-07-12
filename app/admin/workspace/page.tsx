import { redirect } from "next/navigation";
import { getViewer } from "@/lib/access";
import { getActiveWorkspace, listWorkspaceMembers } from "@/lib/workspaces";
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
  const members = await listWorkspaceMembers(active.id);
  const canManage = viewer.isPlatformOperator || active.role === "owner" || active.role === "admin";
  const isOwner = viewer.isPlatformOperator || active.role === "owner";

  return (
    <>
      <WorkspaceSidebar canCreateProjects={viewer.isPlatformOperator} isPlatformOperator={viewer.isPlatformOperator} />
      <div className="page-enter min-w-0 flex-1">
        <WorkspaceTeam
          workspaceId={active.id}
          name={active.name}
          members={members}
          canManage={canManage}
          isOwner={isOwner}
        />
      </div>
    </>
  );
}
