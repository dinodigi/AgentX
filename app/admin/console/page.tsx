import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/access";
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

  const overview = await platformOverview();
  if (!overview) redirect("/admin");

  return (
    <>
      <WorkspaceSidebar canCreateProjects isPlatformOperator />
      <div className="page-enter min-w-0 flex-1">
        <div className="flex justify-end px-6 pt-4">
          <Link href="/admin/console/settings" className="btn btn-ghost text-sm">
            Platform settings
          </Link>
        </div>
        <PlatformConsole workspaces={overview.workspaces} projects={overview.projects} />
      </div>
    </>
  );
}
