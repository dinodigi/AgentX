import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { entries, type AuditActor } from "@/db/schema";
import { listCollections } from "@/lib/collections";
import { listConnectors } from "@/lib/connectors";
import { listAuditLog } from "@/lib/audit";
import { getProject } from "@/lib/admin";
import { brandInk } from "@/lib/brand";
import {
  ProjectOverview,
  type ActivityItem,
  type OverviewCollection,
} from "@/components/admin/ProjectOverview";

/**
 * Project dashboard — the backend's front door (its two endpoints) plus an
 * operations overview: scale, connector health, the collections it exposes,
 * and what changed lately. Every count comes from one grouped query.
 */
export default async function ProjectHome({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const [project, collections, entryCounts, lastByCol, unhandledByCol, connectors, audit, h] =
    await Promise.all([
      getProject(projectId),
      listCollections(projectId),
      db.select({ id: entries.collectionId, n: count() }).from(entries).where(eq(entries.projectId, projectId)).groupBy(entries.collectionId),
      db.select({ id: entries.collectionId, last: sql<string | null>`max(${entries.updatedAt})` }).from(entries).where(eq(entries.projectId, projectId)).groupBy(entries.collectionId),
      db.select({ id: entries.collectionId, n: count() }).from(entries).where(and(eq(entries.projectId, projectId), isNull(entries.handledAt))).groupBy(entries.collectionId),
      listConnectors(projectId),
      listAuditLog(projectId, { limit: 6, offset: 0 }),
      headers(),
    ]);
  if (!project) notFound();

  const countById = new Map(entryCounts.map((c) => [c.id, c.n]));
  const lastById = new Map(lastByCol.map((c) => [c.id, c.last]));
  const unhandledById = new Map(unhandledByCol.map((c) => [c.id, c.n]));

  const origin =
    process.env.APP_URL?.replace(/\/$/, "") ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"}`;

  const overviewCollections: OverviewCollection[] = collections.map((c) => ({
    name: c.name,
    displayName: c.displayName,
    entries: countById.get(c.id) ?? 0,
    fields: c.fields.length,
    publicWrite: c.publicWrite,
    workflow: Boolean(c.workflow),
    unhandled: c.publicWrite ? unhandledById.get(c.id) ?? 0 : 0,
    lastActivity: lastById.get(c.id) ? new Date(lastById.get(c.id)!).toISOString() : null,
  }));

  const totalEntries = overviewCollections.reduce((s, c) => s + c.entries, 0);
  const totalUnhandled = overviewCollections.reduce((s, c) => s + c.unhandled, 0);

  const brand = project.branding.primaryColor ?? "#4f46e5";
  const name = project.branding.displayName ?? project.name;

  return (
    <ProjectOverview
      projectId={projectId}
      name={name}
      initial={name.charAt(0).toUpperCase()}
      logoUrl={project.branding.logoUrl ?? null}
      brand={brand}
      brandInk={brandInk(brand)}
      deliveryBase={`${origin}/api/v1`}
      mcpEndpoint={`${origin}/api/mcp`}
      collections={overviewCollections}
      connectors={connectors.map((c) => ({ type: c.type, status: c.status }))}
      entries={totalEntries}
      unhandled={totalUnhandled}
      activity={audit.map(
        (a): ActivityItem => ({
          when: whenLabel(a.createdAt),
          actor: actorText(a.actor),
          action: actionWord(a.action),
          target: a.collectionName,
        }),
      )}
    />
  );
}

function whenLabel(iso: Date | string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function actorText(actor: AuditActor): string {
  switch (actor.type) {
    case "mcp":
      return "mcp:agent";
    case "admin":
      return "admin";
    case "delivery":
      return actor.userSub ? "member" : "public";
    default:
      return "system";
  }
}

function actionWord(action: string): string {
  const map: Record<string, string> = {
    create: "created",
    update: "updated",
    delete: "deleted",
    restore: "restored",
    purge: "purged",
    transition: "transitioned",
  };
  return map[action] ?? action;
}
