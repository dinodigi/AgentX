import { getSidebarCollapsed } from "@/lib/theme";
import { WorkspaceShellSkeleton } from "@/components/admin/Skeleton";

/**
 * Covers the fleet dashboard AND any child layout still resolving — entering a
 * project shows this while `[projectId]/layout` runs. It is deliberately
 * neutral for that reason: a fleet-specific card grid would be a lie half the
 * time it appears.
 */
export default async function Loading() {
  return <WorkspaceShellSkeleton collapsed={await getSidebarCollapsed()} wide />;
}
