import { UserButton } from "@clerk/nextjs";
import { count, sql } from "drizzle-orm";
import { db } from "@/db";
import { collections, entries, projectConnectors } from "@/db/schema";
import { accessibleProjects } from "@/lib/access";
import { brandInk } from "@/lib/brand";
import { ProjectFleet, type FleetProject } from "@/components/admin/ProjectFleet";

/**
 * The studio — the operator's control plane over every client backend. Each
 * project is a live system; the fleet reports scale, connector health and its
 * last-write pulse. Data comes from grouped queries, never one-per-project.
 */
export default async function AdminHome() {
  const projects = await accessibleProjects();

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
  // Most recently active first — the operator's attention goes to live work.
  fleet.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));

  return (
    <div className="min-h-screen">
      <header className="border-b border-[--color-line] bg-[--color-card]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5 md:px-8">
          <span className="display text-[15px] font-semibold tracking-tight">
            Agent<span className="text-[--color-ink-mute]">X</span>
          </span>
          <UserButton />
        </div>
      </header>
      <div className="page-enter">
        <ProjectFleet projects={fleet} />
      </div>
    </div>
  );
}
