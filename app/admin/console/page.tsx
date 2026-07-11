import { redirect } from "next/navigation";
import { getViewer } from "@/lib/access";
import { getWorkspaceTheme } from "@/lib/theme";
import { getActiveWorkspace, listViewerWorkspaces } from "@/lib/workspaces";
import { platformOverview } from "@/lib/platform";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { PlatformConsole } from "@/components/admin/PlatformConsole";

/**
 * The operator console (B4) — the platform-wide "god view", a separate surface
 * from the everyday dashboard. Operator-gated: non-operators are bounced to
 * their own dashboard. Reads the control plane across every tenant.
 */
export default async function ConsolePage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (!viewer.isPlatformOperator) redirect("/admin");

  const [overview, theme, workspaces, active] = await Promise.all([
    platformOverview(),
    getWorkspaceTheme(),
    listViewerWorkspaces(viewer.userId),
    getActiveWorkspace(viewer),
  ]);
  if (!overview) redirect("/admin");

  return (
    <div className="flex min-h-screen">
      <WorkspaceSidebar
        projects={[]}
        theme={theme}
        canCreateProjects
        isPlatformOperator
        workspaces={workspaces}
        activeWorkspaceId={active.id}
      />
      <div className="page-enter min-w-0 flex-1">
        <PlatformConsole workspaces={overview.workspaces} projects={overview.projects} />
      </div>
    </div>
  );
}
