import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collections, entries, type EventAction } from "@/db/schema";
import { actionHash, runEventAction, type EntryEvent } from "./events";
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
};
