import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collections, entries, projectSchedules, type EventAction, type ScheduleAction } from "@/db/schema";
import { actionHash, dispatchEmail, runEventAction, type EntryEvent } from "./events";
import { deliverWebhook } from "./webhook";
import { matchesClauses } from "./query";
import type { JobHandlers } from "./jobs";

/**
 * Built-in job handlers keyed by `job.kind`. Declarative features register their
 * kind here (G2 `event_action`, G3 `schedule_fire`, …). A handler runs from
 * CURRENT config, never a queued copy, and must be idempotent (at-least-once
 * delivery). `noop` exists so the queue machinery is provable without a feature.
 */
export const HANDLERS: JobHandlers = {
  noop: async () => {},

  /**
   * A delayed event action (G2). The queued payload is REFERENCES + an
   * actionHash — config stays the execution authority: the action is re-located
   * in the CURRENT collection.events by hash (absent = removed/edited,
   * disabled = paused → skip-as-succeeded), and `when` is re-evaluated against
   * the CURRENT entry. So disabling, removing, or editing an action is a true
   * declarative kill switch for its pending delayed sends, and a deleted entry
   * skips silently. Dispatch funnels through runEventAction → webhook_deliveries.
   */
  event_action: async (job) => {
    const p = job.payload as {
      collectionId: string;
      event: EntryEvent;
      entryId: string;
      actionHash: string;
    };

    // (1) CURRENT collection, by id (not the name-keyed cache — renames happen).
    const [collection] = await db
      .select()
      .from(collections)
      .where(and(eq(collections.id, p.collectionId), eq(collections.projectId, job.projectId)))
      .limit(1);
    if (!collection) return; // collection gone → skip-as-succeeded

    // (2) The LIVE action, matched by content hash. Absent (removed or edited)
    // or disabled → skip-as-succeeded. The payload's enqueuedAction copy is
    // display-only and never executed.
    const live = (collection.events?.[p.event] ?? []).find(
      (a: EventAction) => actionHash(a) === p.actionHash,
    );
    if (!live || live.disabled) return;

    // (3) The CURRENT entry — deleted (or trashed) → skip-as-succeeded.
    const [entry] = await db
      .select({ id: entries.id, data: entries.data })
      .from(entries)
      .where(and(eq(entries.id, p.entryId), eq(entries.collectionId, collection.id)))
      .limit(1);
    if (!entry) return;

    // (4) Re-evaluate `when` against the entry AS IT NOW IS.
    if (live.when && live.when.length > 0) {
      if (!matchesClauses(collection.fields, live.when, entry.data)) return;
    }

    // (5) Dispatch — same payload shape as an immediate event, minus
    // previous/changedFields (unknowable at send time; documented).
    await runEventAction(collection, `entry.${p.event}`, live, entry, {
      collection: collection.name,
      entry,
      delayed: { after: live.after },
    });
  },

  /**
   * A recurring-schedule fire (G3). Same run-time-truth rule as event_action:
   * the schedule row is re-fetched — deleted or enabled:false → skip-as-
   * succeeded, and an action edited since enqueue (hash mismatch) → skip. The
   * payload action is never the authority. Outcomes land in webhook_deliveries
   * with a null collectionId (project-level event).
   */
  schedule_fire: async (job) => {
    const p = job.payload as {
      scheduleId: string;
      name: string;
      action: ScheduleAction;
      scheduledFor: string;
    };
    const [s] = await db
      .select()
      .from(projectSchedules)
      .where(and(eq(projectSchedules.id, p.scheduleId), eq(projectSchedules.projectId, job.projectId)))
      .limit(1);
    if (!s || !s.enabled) return; // deleted or paused → skip-as-succeeded
    if (actionHash(s.action as EventAction) !== actionHash(p.action as EventAction)) return; // edited since enqueue

    const firedAt = new Date().toISOString();
    const payload = {
      schedule: { id: s.id, name: s.name },
      scheduledFor: p.scheduledFor,
      firedAt,
    };
    if (s.action.type === "webhook") {
      await deliverWebhook({
        projectId: job.projectId,
        collectionId: null,
        url: s.action.url,
        event: "schedule.fired",
        payload,
      });
    } else {
      // {{name}} / {{scheduledFor}} interpolation for schedule emails.
      const fill = (t: string) =>
        t.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
          k === "name" ? s.name : k === "scheduledFor" ? p.scheduledFor : "",
        );
      const rendered = {
        to: fill(s.action.to),
        subject: fill(s.action.subject),
        text: `schedule "${s.name}" fired\nscheduledFor: ${p.scheduledFor}\nfiredAt: ${firedAt}`,
      };
      await dispatchEmail(job.projectId, null, "schedule.fired", rendered, { ...payload, email: rendered });
    }
  },
};
