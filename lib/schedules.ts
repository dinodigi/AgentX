import { z } from "zod";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  projectSchedules,
  type ProjectSchedule,
  type ScheduleAction,
  type ScheduleRecurrence,
} from "@/db/schema";
import { enqueueJob } from "./jobs";
import { getConnector } from "./connectors";
import { ValidationError } from "./validation";

/**
 * Recurring schedules (G3): preset recurrence objects (no cron strings), ticked
 * by the drain endpoint into dedupeKey'd `schedule_fire` jobs with a
 * CAS-advanced nextRunAt. v1 is deliberately UTC-only (openMinor #6) — IANA
 * timezones and their DST edges are a later increment.
 */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export const recurrenceSchema = z
  .object({
    frequency: z.enum(["hourly", "daily", "weekly", "monthly"]),
    at: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'at must be "HH:MM" (24h), e.g. "09:30"')
      .optional(),
    weekday: z.enum(WEEKDAYS).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    timezone: z.string().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (r.frequency === "weekly" && !r.weekday) bad("weekly needs weekday: sunday..saturday");
    if (r.frequency === "monthly" && !r.dayOfMonth)
      bad("monthly needs dayOfMonth 1..28 (capped at 28 so every month has the day — 29-31 would skip short months)");
    if (r.weekday && r.frequency !== "weekly") bad("weekday only applies to frequency: weekly");
    if (r.dayOfMonth && r.frequency !== "monthly") bad("dayOfMonth only applies to frequency: monthly");
    if (r.at && r.frequency === "hourly") bad('hourly fires at the top of each hour — drop "at"');
    if (r.timezone !== undefined && r.timezone !== "UTC")
      bad('schedules are UTC-only for now — omit timezone or set "UTC" (IANA timezones land in a later increment)');
  });

/** Next strictly-future occurrence after `from`, in UTC. */
export function computeNextRun(r: ScheduleRecurrence, from: Date): Date {
  const [hh, mm] = (r.at ?? "00:00").split(":").map(Number);
  if (r.frequency === "hourly") {
    const d = new Date(from);
    d.setUTCMinutes(0, 0, 0);
    d.setUTCHours(d.getUTCHours() + 1);
    return d;
  }
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hh, mm, 0, 0));
  if (r.frequency === "daily") {
    if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (r.frequency === "weekly") {
    const target = WEEKDAYS.indexOf(r.weekday!);
    while (d.getUTCDay() !== target || d <= from) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  // monthly — dayOfMonth ≤ 28, so every month has it.
  d.setUTCDate(r.dayOfMonth!);
  if (d <= from) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface DefineScheduleInput {
  name: string;
  recurrence: ScheduleRecurrence;
  action: ScheduleAction;
  /** false = paused (kept, not ticked; already-queued fires also skip). */
  enabled?: boolean;
}

/** Create or update (upsert by name). nextRunAt is recomputed from now. */
export async function defineSchedule(
  projectId: string,
  input: DefineScheduleInput,
): Promise<ProjectSchedule> {
  if (!NAME_RE.test(input.name)) {
    throw new ValidationError(
      `schedule name "${input.name}" must be a slug: lowercase letters/digits/-/_, max 64 chars`,
    );
  }
  const a = input.action as ScheduleAction & { when?: unknown; after?: unknown };
  if (a.when !== undefined || a.after !== undefined) {
    throw new ValidationError(
      "schedule actions take no `when`/`after` — there is no entry to evaluate and the recurrence IS the timing; remove those keys",
    );
  }
  if (a.type === "webhook") {
    if (!/^https?:\/\//.test(a.url)) throw new ValidationError("schedule: webhook url must be http(s)");
  } else if (a.type === "email") {
    if (!a.to || !a.subject) throw new ValidationError("schedule: email actions need to + subject");
    if (!(await getConnector(projectId, "resend"))) {
      throw new ValidationError(
        "schedule: email actions need the Resend connector — connect it in project settings first",
        "E_CONNECTOR_REQUIRED",
      );
    }
  } else {
    throw new ValidationError('schedule: action type must be "webhook" or "email"');
  }
  const recurrence = recurrenceSchema.parse(input.recurrence);

  const values = {
    projectId,
    name: input.name,
    recurrence,
    action: input.action,
    enabled: input.enabled ?? true,
    nextRunAt: computeNextRun(recurrence, new Date()),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(projectSchedules)
    .values(values)
    .onConflictDoUpdate({
      target: [projectSchedules.projectId, projectSchedules.name],
      set: {
        recurrence: values.recurrence,
        action: values.action,
        enabled: values.enabled,
        nextRunAt: values.nextRunAt,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  return row;
}

export async function listSchedules(projectId: string): Promise<ProjectSchedule[]> {
  return db
    .select()
    .from(projectSchedules)
    .where(eq(projectSchedules.projectId, projectId))
    .orderBy(asc(projectSchedules.name));
}

/** Delete by name; returns the full spec (the reversibility story — re-define it). */
export async function deleteSchedule(projectId: string, name: string): Promise<ProjectSchedule> {
  const rows = await db
    .delete(projectSchedules)
    .where(and(eq(projectSchedules.projectId, projectId), eq(projectSchedules.name, name)))
    .returning();
  if (rows.length === 0) {
    throw new ValidationError(`no schedule named "${name}" — list_schedules shows what exists`, "E_NOT_FOUND");
  }
  return rows[0];
}

/**
 * Fire due enabled schedules: CAS-advance nextRunAt FIRST (WHERE next_run_at =
 * the claimed value), and only the advance WINNER enqueues the `schedule_fire`
 * job — so two overlapping drains can never double-fire a window. (Enqueue-first
 * would rely on the dedupe key, which stops suppressing the moment the first
 * job completes — a reproducible double-fire under concurrent drains. The
 * dedupeKey stays as belt-and-braces.) Advances from NOW, so a missed window
 * fires once and never backfills.
 */
export async function tickSchedules(): Promise<number> {
  const due = await db
    .select()
    .from(projectSchedules)
    .where(and(eq(projectSchedules.enabled, true), lte(projectSchedules.nextRunAt, new Date())))
    .orderBy(asc(projectSchedules.nextRunAt))
    .limit(20);

  let fired = 0;
  for (const s of due) {
    // CAS compares at MILLISECOND precision (the entries.ts cursor idiom):
    // timestamptz holds microseconds but a JS Date only milliseconds, so a raw
    // eq() on a µs-precision row would never match — the schedule would silently
    // never advance (and never fire) again.
    const won = await db
      .update(projectSchedules)
      .set({
        nextRunAt: computeNextRun(s.recurrence, new Date()),
        lastRunAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectSchedules.id, s.id),
          sql`date_trunc('milliseconds', ${projectSchedules.nextRunAt}) = date_trunc('milliseconds', ${s.nextRunAt}::timestamptz)`,
        ),
      )
      .returning({ id: projectSchedules.id });
    if (won.length === 0) continue; // a concurrent tick claimed this window

    await enqueueJob({
      projectId: s.projectId,
      kind: "schedule_fire",
      dedupeKey: `sched:${s.id}:${s.nextRunAt.toISOString()}`,
      payload: {
        scheduleId: s.id,
        name: s.name,
        action: s.action,
        scheduledFor: s.nextRunAt.toISOString(),
      },
    });
    fired++;
  }
  return fired;
}
