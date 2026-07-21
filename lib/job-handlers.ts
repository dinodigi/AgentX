import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tenantDb } from "./data-plane";
import {
  collections,
  entries,
  projectSchedules,
  type EventAction,
  type MutateClause,
  type ScheduleAction,
} from "@/db/schema";
import { actionHash, dispatchEmail, runEventAction, escapeHtml, htmlToText, type EntryEvent } from "./events";
import { deliverWebhook } from "./webhook";
import { matchesClauses, type WhereItem } from "./query";
import { getCollection } from "./collections";
import { queryEntries, updateEntryIf } from "./entries";
import { MUTATE_MAX_ROWS_PER_TICK } from "./schedules";
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
    const [entry] = await (await tenantDb(job.projectId))
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
    } else if (s.action.type === "mutate") {
      // AUTO-1 (Plugin Bases Plan, Track B): the declarative sweep. Rows are
      // selected by `where` (relative times resolved NOW), then each write is
      // a CAS through updateEntryIf — the guard clauses re-checked atomically,
      // so a row that changed since the query is SKIPPED, never stomped.
      // Transitions ride the normal workflow validation (mcp actor); the
      // audit actor carries the schedule's name. Bounded per tick; the next
      // tick continues — a sweep is a stream, not a bomb.
      const a = s.action;
      const collection = await getCollection(job.projectId, a.collection);
      if (!collection) return; // collection deleted since — skip-as-succeeded
      const resolveClauses = (cs: MutateClause[]): WhereItem[] =>
        cs.map((c) => {
          let value = c.value;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const hours = "daysAgo" in value ? value.daysAgo * 24 : value.hoursAgo;
            value = new Date(Date.now() - hours * 3_600_000).toISOString();
          }
          return { field: c.field, op: c.op, value } as WhereItem;
        });
      const where = resolveClauses(a.where);
      const guards = resolveClauses(a.guard ?? a.where);
      const rows = await queryEntries(collection, { where, limit: MUTATE_MAX_ROWS_PER_TICK });
      let applied = 0;
      let skipped = 0;
      for (const row of rows) {
        const patch: Record<string, unknown> = {};
        for (const [field, spec] of Object.entries(a.set ?? {})) {
          if (spec === "now") patch[field] = new Date().toISOString();
          else if (spec === null) patch[field] = null;
          else if ("value" in spec) patch[field] = spec.value;
          else {
            const src = (row.data as Record<string, unknown>)[spec.copyFrom];
            if (src !== undefined) patch[field] = src; // absent source: skip the stamp, never unset
          }
        }
        if (a.transition && collection.workflow) {
          if (row.data[collection.workflow.field] === a.transition.to) {
            skipped++;
            continue; // already at the target — idempotent re-run
          }
          patch[collection.workflow.field] = a.transition.to;
        }
        if (Object.keys(patch).length === 0) {
          skipped++;
          continue;
        }
        const r = await updateEntryIf(job.projectId, collection, row.id, {
          if: guards,
          data: patch,
          actor: { type: "mcp", schedule: s.name },
        });
        if (r.ok) applied++;
        else skipped++; // guard no longer holds / concurrent change — correct skip
      }
      void applied;
      void skipped;
    } else {
      // {{name}} / {{scheduledFor}} interpolation for schedule emails.
      const val = (k: string) => (k === "name" ? s.name : k === "scheduledFor" ? p.scheduledFor : "");
      const fill = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => val(k));
      const fillHtml = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => escapeHtml(val(k)));
      const rendered = {
        to: fill(s.action.to),
        subject: fill(s.action.subject),
        text: s.action.html
          ? htmlToText(fill(s.action.html))
          : `schedule "${s.name}" fired\nscheduledFor: ${p.scheduledFor}\nfiredAt: ${firedAt}`,
        ...(s.action.html ? { html: fillHtml(s.action.html) } : {}),
      };
      await dispatchEmail(job.projectId, null, "schedule.fired", rendered, { ...payload, email: rendered });
    }
  },
};
