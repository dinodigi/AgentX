import "server-only";
import { count, sql } from "drizzle-orm";
import { db } from "@/db";
import { collections, entries, projectConnectors, projects, workspaceMembers, workspaces } from "@/db/schema";
import { tenantContentStats } from "./data-plane";
import { getViewer } from "./access";
import { brandInk } from "./brand";

/**
 * Platform-wide (god-view) reads for the operator console (B4). Operator-gated
 * at the source: every export returns null for a non-operator, so the console
 * can't leak cross-tenant data even if a page forgets to guard. Reads the
 * control plane only — no tenant secrets.
 */

export interface PlatformWorkspace {
  id: string;
  name: string;
  members: number;
  projects: number;
  createdAt: string;
}

export interface PlatformProject {
  id: string;
  name: string;
  workspaceName: string;
  initial: string;
  brand: string;
  brandInk: string;
  logoUrl: string | null;
  collections: number;
  entries: number;
  connectors: { type: string; status: string }[];
  lastActivity: string | null;
  createdAt: string;
}

export interface PlatformOverview {
  workspaces: PlatformWorkspace[];
  projects: PlatformProject[];
}

export async function platformOverview(): Promise<PlatformOverview | null> {
  const viewer = await getViewer();
  if (!viewer?.isPlatformOperator) return null;

  const [allWorkspaces, memberCounts, allProjects, collectionCounts, entryCounts, connectorRows, activityRows] =
    await Promise.all([
      db.select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt }).from(workspaces),
      db.select({ workspaceId: workspaceMembers.workspaceId, n: count() }).from(workspaceMembers).groupBy(workspaceMembers.workspaceId),
      db.select().from(projects),
      db.select({ projectId: collections.projectId, n: count() }).from(collections).groupBy(collections.projectId),
      db.select({ projectId: entries.projectId, n: count() }).from(entries).groupBy(entries.projectId),
      db.select({ projectId: projectConnectors.projectId, type: projectConnectors.type, status: projectConnectors.status }).from(projectConnectors),
      db.select({ projectId: entries.projectId, last: sql<string | null>`max(${entries.updatedAt})` }).from(entries).groupBy(entries.projectId),
    ]);

  const wsName = new Map(allWorkspaces.map((w) => [w.id, w.name]));
  const memberById = new Map(memberCounts.map((m) => [m.workspaceId, m.n]));
  const projCountByWs = new Map<string, number>();
  const colsById = new Map(collectionCounts.map((c) => [c.projectId, c.n]));
  const entriesById = new Map(entryCounts.map((c) => [c.projectId, c.n]));
  const activityById = new Map(activityRows.map((a) => [a.projectId, a.last]));
  const connectorsById = new Map<string, { type: string; status: string }[]>();
  for (const c of connectorRows) {
    const list = connectorsById.get(c.projectId) ?? [];
    list.push({ type: c.type, status: c.status });
    connectorsById.set(c.projectId, list);
  }

  // Connector-backed projects' content left the shared table — the grouped
  // queries above see zero rows for them. Fan out to their tenant DBs (A2).
  const neonIds = connectorRows.filter((c) => c.type === "neon").map((c) => c.projectId);
  const tenantStats = await tenantContentStats(neonIds);
  for (const p of allProjects) {
    if (p.workspaceId) projCountByWs.set(p.workspaceId, (projCountByWs.get(p.workspaceId) ?? 0) + 1);
  }

  const workspacesOut: PlatformWorkspace[] = allWorkspaces
    .map((w) => ({
      id: w.id,
      name: w.name,
      members: memberById.get(w.id) ?? 0,
      projects: projCountByWs.get(w.id) ?? 0,
      createdAt: w.createdAt.toISOString(),
    }))
    .sort((a, b) => b.projects - a.projects || a.name.localeCompare(b.name));

  const projectsOut: PlatformProject[] = allProjects
    .map((p) => {
      const brand = p.branding?.primaryColor ?? "#4f46e5";
      const name = p.branding?.displayName ?? p.name;
      const tenant = tenantStats.get(p.id);
      const last = activityById.get(p.id);
      return {
        id: p.id,
        name,
        workspaceName: p.workspaceId ? (wsName.get(p.workspaceId) ?? "—") : "— (no workspace)",
        initial: name.charAt(0).toUpperCase(),
        brand,
        brandInk: brandInk(brand),
        logoUrl: p.branding?.logoUrl ?? null,
        collections: colsById.get(p.id) ?? 0,
        entries: tenant ? tenant.entries : (entriesById.get(p.id) ?? 0),
        connectors: connectorsById.get(p.id) ?? [],
        lastActivity: tenant ? tenant.lastActivity : last ? new Date(last).toISOString() : null,
        createdAt: p.createdAt.toISOString(),
      };
    })
    .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));

  return { workspaces: workspacesOut, projects: projectsOut };
}
