import "server-only";
import { count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  assets,
  collections,
  entries,
  projectConnectors,
  projects,
  rateWindows,
  usageDaily,
  workspaceMembers,
  workspaces,
} from "@/db/schema";
import { tenantContentStats } from "./data-plane";
import { getViewer } from "./access";
import { brandInk } from "./brand";
import { PAID_CAPS, SANDBOX_CAPS } from "./caps";

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
  /** Grouping key for the console; null = legacy/operator-era (no workspace). */
  workspaceId: string | null;
  workspaceName: string;
  initial: string;
  brand: string;
  brandInk: string;
  logoUrl: string | null;
  collections: number;
  entries: number;
  /** Media bytes (shared-plane sum, tenant-DB overlay for connector-backed). */
  assetBytes: number;
  connectors: { type: string; status: string }[];
  lastActivity: string | null;
  createdAt: string;
  /** B2/B4 lifecycle: 'setup' | 'active' | 'suspended'. */
  status: string;
  /** B3: 'sandbox' | 'byo' | 'managed' | null (legacy/operator-era). */
  plan: string | null;
  /** B3: 'active' | 'past_due' | 'canceled' | 'exempt' | null (unbilled). */
  billing: string | null;
  /** The plan's caps (B2 sandbox / B3 paid ceilings); null = uncapped legacy. */
  caps: { entries: number; collections: number; assetBytes: number } | null;
  /** C2 metering: today's limited-surface requests (UTC day, rollup + live windows). */
  requestsToday: number;
}

export interface PlatformOverview {
  workspaces: PlatformWorkspace[];
  projects: PlatformProject[];
}

export async function platformOverview(): Promise<PlatformOverview | null> {
  const viewer = await getViewer();
  if (!viewer?.isPlatformOperator) return null;

  const [allWorkspaces, memberCounts, allProjects, collectionCounts, entryCounts, connectorRows, activityRows, assetSums, requestsById] =
    await Promise.all([
      db.select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt }).from(workspaces),
      db.select({ workspaceId: workspaceMembers.workspaceId, n: count() }).from(workspaceMembers).groupBy(workspaceMembers.workspaceId),
      db.select().from(projects),
      db.select({ projectId: collections.projectId, n: count() }).from(collections).groupBy(collections.projectId),
      db.select({ projectId: entries.projectId, n: count() }).from(entries).groupBy(entries.projectId),
      db.select({ projectId: projectConnectors.projectId, type: projectConnectors.type, status: projectConnectors.status }).from(projectConnectors),
      db.select({ projectId: entries.projectId, last: sql<string | null>`max(${entries.updatedAt})` }).from(entries).groupBy(entries.projectId),
      db.select({ projectId: assets.projectId, total: sql<string>`coalesce(sum(${assets.size}::bigint), 0)` }).from(assets).groupBy(assets.projectId),
      requestsTodayByProject(),
    ]);

  const wsName = new Map(allWorkspaces.map((w) => [w.id, w.name]));
  const memberById = new Map(memberCounts.map((m) => [m.workspaceId, m.n]));
  const projCountByWs = new Map<string, number>();
  const colsById = new Map(collectionCounts.map((c) => [c.projectId, c.n]));
  const entriesById = new Map(entryCounts.map((c) => [c.projectId, c.n]));
  const activityById = new Map(activityRows.map((a) => [a.projectId, a.last]));
  const bytesById = new Map(assetSums.map((a) => [a.projectId, Number(a.total)]));
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
        workspaceId: p.workspaceId ?? null,
        workspaceName: p.workspaceId ? (wsName.get(p.workspaceId) ?? "—") : "— (no workspace)",
        initial: name.charAt(0).toUpperCase(),
        brand,
        brandInk: brandInk(brand),
        logoUrl: p.branding?.logoUrl ?? null,
        collections: colsById.get(p.id) ?? 0,
        entries: tenant ? tenant.entries : (entriesById.get(p.id) ?? 0),
        assetBytes: tenant ? tenant.assetBytes : (bytesById.get(p.id) ?? 0),
        connectors: connectorsById.get(p.id) ?? [],
        lastActivity: tenant ? tenant.lastActivity : last ? new Date(last).toISOString() : null,
        createdAt: p.createdAt.toISOString(),
        status: p.status,
        plan: p.plan ?? null,
        billing: p.billingExempt ? "exempt" : (p.billingStatus ?? null),
        caps: p.plan === "sandbox" ? SANDBOX_CAPS : p.plan === "byo" || p.plan === "managed" ? PAID_CAPS : null,
        requestsToday: requestsById.get(p.id) ?? 0,
      };
    })
    .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));

  return { workspaces: workspacesOut, projects: projectsOut };
}

/**
 * Today's (UTC) limited-surface request count per project: the rolled-up
 * usage_daily row PLUS the still-live rate windows the rollup hasn't folded
 * yet — so the console reads current, not two-drains-behind.
 */
async function requestsTodayByProject(): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const [rolled, live] = await Promise.all([
    db.select({ projectId: usageDaily.projectId, n: usageDaily.count }).from(usageDaily).where(eq(usageDaily.day, today)),
    db
      .select({ projectId: rateWindows.projectId, n: sql<string>`sum(${rateWindows.count})` })
      .from(rateWindows)
      .where(sql`${rateWindows.projectId} IS NOT NULL AND (${rateWindows.windowStart} AT TIME ZONE 'UTC')::date = ${today}`)
      .groupBy(rateWindows.projectId),
  ]);
  const out = new Map<string, number>();
  for (const r of rolled) out.set(r.projectId, r.n);
  for (const l of live) {
    if (l.projectId) out.set(l.projectId, (out.get(l.projectId) ?? 0) + Number(l.n));
  }
  return out;
}
