import "server-only";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { controlDb } from "@/db";
import { platformNotices, projects, webhookDeliveries } from "@/db/schema";
import { effectiveCatalog, enabledPluginVersions } from "./plugins";
import { listConnectors } from "./connectors";

/**
 * The session briefing (Plugin Bases Plan, Track C) — what get_project_info
 * hands an agent at session start, closing the "nobody knows until they open
 * the IDE" gap: plugin update OFFERS (never pushed; adopting = re-reconcile
 * through the existing gates, then enable_plugin again to acknowledge),
 * platform notices shown ONCE per project, and a health summary. `attention`
 * is the do-first list; an empty briefing is the normal, boring case.
 */

export interface Briefing {
  attention: string[];
  updates: { plugin: string; from: string | null; to: string; note?: string }[];
  notices: { message: string; severity: string; at: string }[];
  health: {
    connectors: { type: string; status: string }[];
    failedDeliveries24h: number;
  };
}

/** major-version bump = review-first (semver-ish; non-numeric compares lax). */
function majorBump(from: string | null, to: string): boolean {
  if (!from) return false;
  const m = (v: string) => Number.parseInt(v.split(".")[0] ?? "", 10);
  const a = m(from);
  const b = m(to);
  return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

export async function buildBriefing(projectId: string): Promise<Briefing> {
  const [versions, catalog, connectors, [proj]] = await Promise.all([
    enabledPluginVersions(projectId),
    effectiveCatalog(projectId),
    listConnectors(projectId),
    controlDb.select({ seen: projects.briefingSeenAt }).from(projects).where(eq(projects.id, projectId)).limit(1),
  ]);

  const attention: string[] = [];

  // Plugin update offers: acknowledged version vs the catalog. null = enabled
  // before version tracking → offered as "adopt current to start tracking".
  const updates: Briefing["updates"] = [];
  for (const [id, ackVersion] of versions) {
    const def = catalog.find((p) => p.id === id);
    if (!def) continue; // enabled row whose def vanished — nothing to offer
    if (ackVersion === def.version) continue;
    const note = ackVersion === null ? "enabled before version tracking — re-apply and re-enable to start tracking" : undefined;
    updates.push({ plugin: id, from: ackVersion, to: def.version, ...(note ? { note } : {}) });
    if (majorBump(ackVersion, def.version)) {
      attention.push(`plugin "${id}" has a MAJOR update (${ackVersion} → ${def.version}) — review get_plugin before adopting`);
    }
  }

  // Platform notices: created after the project's last-seen stamp, shown once.
  const seen = proj?.seen ?? null;
  const noticeRows = await controlDb
    .select()
    .from(platformNotices)
    .where(seen ? gt(platformNotices.createdAt, seen) : sql`true`)
    .orderBy(desc(platformNotices.createdAt))
    .limit(10);
  const notices = noticeRows.map((n) => ({
    message: n.message,
    severity: n.severity,
    at: n.createdAt.toISOString(),
  }));
  for (const n of noticeRows) {
    if (n.severity === "attention") attention.push(`platform notice: ${n.message}`);
  }
  await controlDb.update(projects).set({ briefingSeenAt: new Date() }).where(eq(projects.id, projectId));

  // Health: connector states + failed webhook deliveries in the last 24h.
  const connectorHealth = connectors.map((c) => ({ type: c.type, status: c.status }));
  for (const c of connectorHealth) {
    if (c.status === "error") attention.push(`connector "${c.type}" is in error — test it in the admin Connectors tab`);
  }
  const [{ count: failed }] = (await controlDb
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.projectId, projectId),
        eq(webhookDeliveries.status, "failed"),
        gt(webhookDeliveries.createdAt, sql`now() - interval '24 hours'`),
      ),
    )) as { count: number }[];

  return {
    attention,
    updates,
    notices,
    health: { connectors: connectorHealth, failedDeliveries24h: failed },
  };
}
