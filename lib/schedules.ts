import { z } from "zod";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  projects,
  projectSchedules,
  type ProjectSchedule,
  type ScheduleAction,
  type ScheduleRecurrence,
} from "@/db/schema";
import { enqueueJob } from "./jobs";
import { getConnector } from "./connectors";
import { getCollection } from "./collections";
import { WHERE_OPS } from "./query";
import { allowedFroms, isTransitionTarget } from "./workflow";
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

/** AUTO-1 hard caps — a sweep is surgical, never a bulldozer. */
export const MUTATE_MAX_CLAUSES = 8;
export const MUTATE_MAX_SET_FIELDS = 10;
export const MUTATE_MAX_ROWS_PER_TICK = 200;

/**
 * Define-time validation for the declarative mutation action (AUTO-1). The
 * vocabulary is CLOSED on purpose — no arithmetic, no branching, no free
 * expressions. What can't be validated here (op/value fit) fails safely at
 * run through the same query/update validation every write uses.
 */
async function validateMutateAction(
  projectId: string,
  a: Extract<ScheduleAction, { type: "mutate" }>,
): Promise<void> {
  const bad = (m: string): never => {
    throw new ValidationError(`schedule mutate: ${m}`);
  };
  const collection = await getCollection(projectId, a.collection);
  if (!collection) bad(`unknown collection "${a.collection}" — create it first`);
  const fieldNames = new Set(collection!.fields.map((f) => f.name));

  if (!Array.isArray(a.where) || a.where.length === 0) {
    bad("`where` needs at least one clause — a sweep must SELECT rows, never mutate a whole collection blind");
  }
  if (a.where.length > MUTATE_MAX_CLAUSES || (a.guard?.length ?? 0) > MUTATE_MAX_CLAUSES) {
    bad(`at most ${MUTATE_MAX_CLAUSES} clauses in where/guard`);
  }
  for (const c of [...a.where, ...(a.guard ?? [])]) {
    if (!c || typeof c.field !== "string" || !fieldNames.has(c.field)) {
      bad(`clause field "${c?.field}" is not a field of "${a.collection}"`);
    }
    if (!(WHERE_OPS as readonly string[]).includes(c.op)) {
      bad(`clause op "${c.op}" — allowed: ${WHERE_OPS.join(", ")}`);
    }
  }

  const setEntries = Object.entries(a.set ?? {});
  if (!a.transition && setEntries.length === 0) bad("declare at least one of `transition` or `set`");
  if (setEntries.length > MUTATE_MAX_SET_FIELDS) bad(`at most ${MUTATE_MAX_SET_FIELDS} set fields`);

  const wf = collection!.workflow;
  if (a.transition) {
    if (!wf) bad(`"${a.collection}" has no workflow — transition needs one (or use set)`);
    if (typeof a.transition.to !== "string" || !isTransitionTarget(wf!, a.transition.to)) {
      bad(`"${a.transition?.to}" is not a transition target of "${a.collection}"'s workflow`);
    }
    if (allowedFroms(wf!, a.transition.to, "mcp").length === 0) {
      bad(`no mcp-actor transition reaches "${a.transition.to}" — scheduled mutations move workflows as the mcp actor`);
    }
  }
  for (const [field, spec] of setEntries) {
    if (!fieldNames.has(field)) bad(`set field "${field}" is not a field of "${a.collection}"`);
    if (wf && field === wf.field) bad(`set must not touch the workflow field "${field}" — use transition`);
    const def = collection!.fields.find((f) => f.name === field)!;
    if (def.computed) bad(`set field "${field}" is computed (server-stamped) — it cannot be set`);
    const okShape =
      spec === "now" ||
      spec === null ||
      (typeof spec === "object" &&
        spec !== null &&
        (("value" in spec && ["string", "number", "boolean"].includes(typeof spec.value)) ||
          ("copyFrom" in spec && typeof spec.copyFrom === "string" && fieldNames.has(spec.copyFrom))));
    if (!okShape) {
      bad(
        `set.${field} must be "now", null (unset), {value: <literal>}, or {copyFrom: "<existing field>"} — the vocabulary is closed`,
      );
    }
  }
}

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
  } else if (a.type === "mutate") {
    await validateMutateAction(projectId, a);
  } else {
    throw new ValidationError('schedule: action type must be "webhook", "email", or "mutate"');
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
  // Non-active projects don't tick (B4): a suspended project's schedules stay
  // where they are and the missed-window rule ("fires once, never backfills")
  // gives exactly the right resume behavior on unsuspension — no burst.
  const due = await db
    .select()
    .from(projectSchedules)
    .innerJoin(projects, eq(projects.id, projectSchedules.projectId))
    .where(
      and(
        eq(projectSchedules.enabled, true),
        lte(projectSchedules.nextRunAt, new Date()),
        eq(projects.status, "active"),
      ),
    )
    .orderBy(asc(projectSchedules.nextRunAt))
    .limit(20)
    .then((rows) => rows.map((r) => r.project_schedules));

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
