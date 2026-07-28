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
    /**
     * E1 — `checkedAt` is load-bearing, not decoration.
     *
     * `status` is the verdict of the LAST PROBE, not a live reading. A probe
     * that threw — a network blip, an 8s timeout — persists `error` until
     * someone re-tests, and the briefing then reports that stale verdict as if
     * it were current truth. A reporter hit exactly this: r2/clerk/resend all
     * read `error` while `upload_asset` succeeded and the returned public URL
     * served HTTP 200. The three that failed are the three whose probes make
     * OUTBOUND HTTP calls; neon, which connects to the database directly, was
     * unaffected — a transient egress failure, recorded permanently.
     *
     * Carrying the timestamp lets a reader tell "broken now" from "failed a
     * probe hours ago", which is the whole difference.
     */
    connectors: { type: string; status: string; checkedAt: string | null }[];
    failedDeliveries24h: number;
  };
}

/** "3h ago" / "2d ago" — coarse on purpose; the point is staleness, not precision. */
function relativeAge(iso: string): string | null {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 2) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
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
  // E1: `updatedAt` is when the row last changed, and testConnector stamps it on
  // every probe — so for a row sitting at `error` it IS the failed-probe time.
  // (Rotating a secret also bumps it, but that path writes `connected`, so it
  // can never make a stale error look fresh.)
  const connectorHealth = connectors.map((c) => ({
    type: c.type,
    status: c.status,
    checkedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null,
  }));
  for (const c of connectorHealth) {
    if (c.status !== "error") continue;
    // Say what we actually know — a probe failed at a time — instead of
    // asserting a live fault we have not observed. The old copy ("is in error")
    // sent a reporter hunting a broken R2 connector that was serving fine.
    const ago = c.checkedAt ? relativeAge(c.checkedAt) : null;
    attention.push(
      ago
        ? `connector "${c.type}" FAILED ITS LAST CHECK ${ago} — that is a point-in-time probe, not a live reading, so it may be working now; re-test it in the admin Connectors tab to refresh the verdict`
        : `connector "${c.type}" failed its last check — re-test it in the admin Connectors tab`,
    );
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
