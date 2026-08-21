import { getSidebarCollapsed } from "@/lib/theme";
import { WorkspaceShellSkeleton } from "@/components/admin/Skeleton";

export default async function Loading() {
  return <WorkspaceShellSkeleton collapsed={await getSidebarCollapsed()} />;
}
