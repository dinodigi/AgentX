import { redirect } from "next/navigation";
import { count, sql } from "drizzle-orm";
import { db } from "@/db";
import { collections, entries, projectConnectors, type Project } from "@/db/schema";
import { tenantContentStats } from "@/lib/data-plane";
import { getViewer } from "@/lib/access";
import { brandInk } from "@/lib/brand";
import { getActiveWorkspace, projectsInWorkspace } from "@/lib/workspaces";
import { ProjectFleet, type FleetProject } from "@/components/admin/ProjectFleet";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";

/**
 * The studio home — the fleet for ONE workspace at a time (B1c). The sidebar's
 * workspace switcher picks which; this scopes to it. Cross-tenant is the
 * operator console, not here.
 */
export default async function AdminHome() {
  const viewer = await getViewer();
  if (!viewer) redirect("/sign-in");

  const active = await getActiveWorkspace(viewer);
  // B2: creation is self-serve for workspace owners/admins (the free-sandbox
  // path; the paid planes stay gated inside the form until B3).
  const canCreate = viewer.isPlatformOperator || active.role === "owner" || active.role === "admin";
  const projects = await projectsInWorkspace(active.id);

  const [collectionCounts, entryCounts, connectorRows, activityRows] = await Promise.all([
    db.select({ projectId: collections.projectId, n: count() }).from(collections).groupBy(collections.projectId),
    db.select({ projectId: entries.projectId, n: count() }).from(entries).groupBy(entries.projectId),
    db
      .select({ projectId: projectConnectors.projectId, type: projectConnectors.type, status: projectConnectors.status })
      .from(projectConnectors),
    db
      .select({ projectId: entries.projectId, last: sql<string | null>`max(${entries.updatedAt})` })
      .from(entries)
      .groupBy(entries.projectId),
  ]);

  const colsById = new Map(collectionCounts.map((c) => [c.projectId, c.n]));
  const entriesById = new Map(entryCounts.map((c) => [c.projectId, c.n]));
  const activityById = new Map(activityRows.map((a) => [a.projectId, a.last]));
  const connectorsById = new Map<string, { type: string; status: string }[]>();
  for (const c of connectorRows) {
    const list = connectorsById.get(c.projectId) ?? [];
    list.push({ type: c.type, status: c.status });
    connectorsById.set(c.projectId, list);
  }

  // Connector-backed projects keep content in their own DBs — the grouped
  // queries above can't see it. Fan out for this workspace's neon projects (A2).
  const workspaceIds = new Set(projects.map((p) => p.id));
  const neonIds = connectorRows
    .filter((c) => c.type === "neon" && workspaceIds.has(c.projectId))
    .map((c) => c.projectId);
  const tenantStats = await tenantContentStats(neonIds);

  const toFleet = (p: Project): FleetProject => {
    const brand = p.branding?.primaryColor ?? "#4f46e5";
    const name = p.branding?.displayName ?? p.name;
    const tenant = tenantStats.get(p.id);
    const last = activityById.get(p.id);
    return {
      id: p.id,
      name,
      initial: name.charAt(0).toUpperCase(),
      icon: p.branding?.icon ?? null,
      logoUrl: p.branding?.logoUrl ?? null,
      brand,
      brandInk: brandInk(brand),
      collections: colsById.get(p.id) ?? 0,
      entries: tenant ? tenant.entries : (entriesById.get(p.id) ?? 0),
      connectors: connectorsById.get(p.id) ?? [],
      lastActivity: tenant ? tenant.lastActivity : last ? new Date(last).toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    };
  };
  const fleet = projects.map(toFleet).sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));

  return (
    <>
      <WorkspaceSidebar canCreateProjects={canCreate} isPlatformOperator={viewer.isPlatformOperator} />
      <div className="page-enter min-w-0 flex-1">
        <ProjectFleet projects={fleet} canCreate={canCreate} workspaceName={active.name} />
      </div>
    </>
  );
}
