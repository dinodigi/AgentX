import { redirect } from "next/navigation";
import { accessibleProjects, getViewer } from "@/lib/access";
import { brandInk } from "@/lib/brand";
import { getWorkspaceTheme } from "@/lib/theme";
import { platformOverview } from "@/lib/platform";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import { PlatformConsole } from "@/components/admin/PlatformConsole";
import type { SwitcherProject } from "@/components/admin/ProjectSwitcher";

/**
 * The operator console (B4) — the platform-wide "god view", a separate surface
 * from the everyday dashboard. Operator-gated: non-operators are bounced to
 * their own dashboard. Reads the control plane across every tenant.
 */
export default async function ConsolePage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");
  if (!viewer.isPlatformOperator) redirect("/admin");

  const [overview, theme, projects] = await Promise.all([
    platformOverview(),
    getWorkspaceTheme(),
    accessibleProjects(),
  ]);
  if (!overview) redirect("/admin");

  const switcher: SwitcherProject[] = projects.map((p) => {
    const name = p.branding?.displayName ?? p.name;
    const brand = p.branding?.primaryColor ?? "#4f46e5";
    return { id: p.id, name, initial: name.charAt(0).toUpperCase(), brand, brandInk: brandInk(brand), logoUrl: p.branding?.logoUrl ?? null };
  });

  return (
    <div className="flex min-h-screen">
      <WorkspaceSidebar projects={switcher} theme={theme} canCreateProjects isPlatformOperator />
      <div className="page-enter min-w-0 flex-1">
        <PlatformConsole workspaces={overview.workspaces} projects={overview.projects} />
      </div>
    </div>
  );
}
