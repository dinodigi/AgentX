import { count, sql } from "drizzle-orm";
import { db } from "@/db";
import { collections, entries, projectConnectors } from "@/db/schema";
import { accessibleProjects, getViewer } from "@/lib/access";
import { brandInk } from "@/lib/brand";
import { getWorkspaceTheme } from "@/lib/theme";
import { ProjectFleet, type FleetProject } from "@/components/admin/ProjectFleet";
import { WorkspaceSidebar } from "@/components/admin/WorkspaceSidebar";
import type { SwitcherProject } from "@/components/admin/ProjectSwitcher";

/**
 * The studio — the operator's workspace over every client backend. The unified
 * sidebar frames it (switcher + account + theme); the main area is the fleet,
 * each project a live system with scale, connector health and a last-write pulse.
 */
export default async function AdminHome() {
  const [projects, theme, viewer] = await Promise.all([
    accessibleProjects(),
    getWorkspaceTheme(),
    getViewer(),
  ]);
  const canCreate = viewer?.isPlatformOperator ?? false;

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

  const switcher: SwitcherProject[] = projects.map((p) => {
    const name = p.branding?.displayName ?? p.name;
    const brand = p.branding?.primaryColor ?? "#4f46e5";
    return { id: p.id, name, initial: name.charAt(0).toUpperCase(), brand, brandInk: brandInk(brand), logoUrl: p.branding?.logoUrl ?? null };
  });

  const fleet: FleetProject[] = projects.map((p) => {
    const brand = p.branding?.primaryColor ?? "#4f46e5";
    const name = p.branding?.displayName ?? p.name;
    const last = activityById.get(p.id);
    return {
      id: p.id,
      name,
      initial: name.charAt(0).toUpperCase(),
      logoUrl: p.branding?.logoUrl ?? null,
      brand,
      brandInk: brandInk(brand),
      collections: colsById.get(p.id) ?? 0,
      entries: entriesById.get(p.id) ?? 0,
      connectors: connectorsById.get(p.id) ?? [],
      lastActivity: last ? new Date(last).toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    };
  });
  fleet.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));

  return (
    <div className="flex min-h-screen">
      <WorkspaceSidebar projects={switcher} theme={theme} canCreateProjects={canCreate} />
      <div className="page-enter min-w-0 flex-1">
        <ProjectFleet projects={fleet} canCreate={canCreate} />
      </div>
    </div>
  );
}
