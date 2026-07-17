import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { tenantDb } from "@/lib/data-plane";
import { assets, entries, rateWindows, usageDaily, type AuditActor } from "@/db/schema";
import { effectiveCaps } from "@/lib/platform-settings";
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
import { SetupPanel } from "@/components/admin/SetupPanel";

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

  const project = await getProject(projectId);
  if (!project) notFound();

  // B2: a setup-state project shows the setup surface instead of the overview
  // — BEFORE any tenant-plane read (a half-provisioned data plane fails closed
  // by design, and there is nothing to show yet anyway).
  if (project.status === "setup") {
    const conns = await listConnectors(projectId);
    const neon = conns.find((c) => c.type === "neon");
    const paidPlan = project.plan === "byo" || project.plan === "managed" ? project.plan : null;
    return (
      <SetupPanel
        projectId={projectId}
        name={project.branding?.displayName ?? project.name}
        plan={paidPlan}
        dbConnected={neon?.status === "connected"}
        dbStatus={neon?.status ?? null}
        billingRequired={paidPlan !== null && !project.billingExempt}
        billingActive={project.billingStatus === "active"}
        priceLabel={paidPlan === "managed" ? "$29/mo" : "$19/mo"}
      />
    );
  }

  const tdb = await tenantDb(projectId);
  const today = new Date().toISOString().slice(0, 10);
  const [collections, entryCounts, lastByCol, unhandledByCol, connectors, audit, h, dataBytesRow, assetBytesRow, reqRolled, reqLive, caps] =
    await Promise.all([
      listCollections(projectId),
      tdb.select({ id: entries.collectionId, n: count() }).from(entries).where(eq(entries.projectId, projectId)).groupBy(entries.collectionId),
      tdb.select({ id: entries.collectionId, last: sql<string | null>`max(${entries.updatedAt})` }).from(entries).where(eq(entries.projectId, projectId)).groupBy(entries.collectionId),
      tdb.select({ id: entries.collectionId, n: count() }).from(entries).where(and(eq(entries.projectId, projectId), isNull(entries.handledAt))).groupBy(entries.collectionId),
      listConnectors(projectId),
      listAuditLog(projectId, { limit: 6, offset: 0 }),
      headers(),
      // Usage card: stored content + media (tenant plane) and requests today
      // (control plane: rollup + still-live windows, same math as the console).
      tdb.select({ total: sql<string>`coalesce(sum(pg_column_size(${entries.data})), 0)` }).from(entries).where(eq(entries.projectId, projectId)),
      tdb.select({ total: sql<string>`coalesce(sum(${assets.size}::bigint), 0)` }).from(assets).where(eq(assets.projectId, projectId)),
      db.select({ n: usageDaily.count }).from(usageDaily).where(and(eq(usageDaily.projectId, projectId), eq(usageDaily.day, today))),
      db.select({ n: sql<string>`coalesce(sum(${rateWindows.count}), 0)` }).from(rateWindows).where(sql`${rateWindows.projectId} = ${projectId} AND (${rateWindows.windowStart} AT TIME ZONE 'UTC')::date = ${today}`),
      effectiveCaps(),
    ]);

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
      icon={project.branding.icon ?? null}
      logoUrl={project.branding.logoUrl ?? null}
      brand={brand}
      brandInk={brandInk(brand)}
      deliveryBase={`${origin}/api/v1`}
      mcpEndpoint={`${origin}/api/mcp`}
      collections={overviewCollections}
      connectors={connectors.map((c) => ({ type: c.type, status: c.status }))}
      entries={totalEntries}
      unhandled={totalUnhandled}
      usage={{
        plan: project.plan ?? null,
        dataBytes: Number(dataBytesRow[0]?.total ?? 0),
        assetBytes: Number(assetBytesRow[0]?.total ?? 0),
        requestsToday: (reqRolled[0]?.n ?? 0) + Number(reqLive[0]?.n ?? 0),
        caps:
          project.plan === "sandbox"
            ? caps.sandbox
            : project.plan === "byo" || project.plan === "managed"
              ? caps.paid
              : null,
      }}
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
