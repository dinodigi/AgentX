import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs, type Job, type JobStatus } from "@/db/schema";

/**
 * The shared job runner over the pg `jobs` table. Work is claimed with a single
 * FOR UPDATE SKIP LOCKED statement (proven safe on the neon-http driver — one
 * statement is one implicit transaction, and concurrent drains partition work
 * with zero coordination). Only declarative features enqueue jobs; there is no
 * arbitrary-code path. Delivery is at-least-once (a lost finishJob write re-runs
 * the job after the lease expires), so handlers must be idempotent / re-resolve
 * their action from current config.
 */

/** Stale-lease reclaim window. MUST exceed worst-case single-handler time
 * (drainJobs' budgetMs bounds a whole drain; this bounds one job). */
const LEASE_MS = 120_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** The subset a handler needs — claimed with camelCase aliases so no snake_case
 * leaks out of the raw statement. */
export interface ClaimedJob {
  id: string;
  projectId: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

export interface EnqueueJobInput {
  projectId: string;
  kind: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  /** When set, a second PENDING job of the same (projectId, kind, dedupeKey) is
   * silently suppressed via the partial unique index. */
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Enqueue a job. Returns the row, or null when a pending duplicate suppressed it. */
export async function enqueueJob(input: EnqueueJobInput): Promise<Job | null> {
  const rows = await db
    .insert(jobs)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey ?? null,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

/** Claim up to n due pending jobs in ONE statement. attempts is incremented on
 * claim, so the RETURNED attempts is the count INCLUDING this attempt. */
export async function claimDueJobs(n: number): Promise<ClaimedJob[]> {
  const result = await db.execute(sql`
    UPDATE ${jobs} SET status = 'running', claimed_at = now(), attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM ${jobs}
      WHERE status = 'pending' AND run_at <= now()
      ORDER BY run_at
      LIMIT ${n}
      FOR UPDATE SKIP LOCKED )
    RETURNING id, project_id AS "projectId", kind, payload, attempts, max_attempts AS "maxAttempts"`);
  return ((result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as ClaimedJob[];
}

/** Return running jobs whose lease has expired to pending (or failed if their
 * attempts are exhausted) — recovers work from a drain that died mid-flight. */
export async function reclaimStale(): Promise<number> {
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();
  const result = await db.execute(sql`
    UPDATE ${jobs}
    SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
        claimed_at = NULL, updated_at = now(),
        last_error = COALESCE(last_error, 'stale lease reclaimed')
    WHERE status = 'running' AND claimed_at < ${cutoff}
    RETURNING id`);
  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return rows.length;
}

/** Mark a claimed job succeeded, or reschedule (exponential backoff) / fail it. */
export async function finishJob(
  job: ClaimedJob,
  result: { ok: true } | { ok: false; error: string },
): Promise<void> {
  if (result.ok) {
    await db.update(jobs).set({ status: "succeeded", lastError: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
    return;
  }
  const exhausted = job.attempts >= job.maxAttempts;
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** job.attempts, BACKOFF_CAP_MS);
  await db
    .update(jobs)
    .set({
      status: exhausted ? "failed" : "pending",
      lastError: result.error.slice(0, 2000),
      claimedAt: null,
      updatedAt: new Date(),
      ...(exhausted ? {} : { runAt: new Date(Date.now() + backoff) }),
    })
    .where(eq(jobs.id, job.id));
}

export interface DrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
  rescheduled: number;
}

/** Claim + run due jobs until the count or time budget is hit. Each job is
 * isolated: a throwing handler reschedules/fails only that job. */
export async function drainJobs(
  handlers: JobHandlers,
  opts: { maxJobs?: number; budgetMs?: number } = {},
): Promise<DrainResult> {
  const maxJobs = opts.maxJobs ?? 10;
  const budgetMs = opts.budgetMs ?? 15_000;
  const start = Date.now();
  let claimed = 0,
    succeeded = 0,
    failed = 0,
    rescheduled = 0;

  while (claimed < maxJobs && Date.now() - start < budgetMs) {
    const [job] = await claimDueJobs(1);
    if (!job) break;
    claimed++;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`no handler registered for job kind "${job.kind}"`);
      await handler(job);
      await finishJob(job, { ok: true });
      succeeded++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await finishJob(job, { ok: false, error });
      if (job.attempts >= job.maxAttempts) failed++;
      else rescheduled++;
    }
  }
  return { claimed, succeeded, failed, rescheduled };
}

export type CancelJobResult =
  | { ok: true; job: Job }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_pending"; status: JobStatus };

/**
 * Cancel ONE pending job (per-job override; the declarative kill switch for
 * delayed event actions is disabling/removing the action itself). The cancel is
 * a single conditional UPDATE so a concurrent claim can't race the check: only
 * a still-pending row cancels; otherwise a diagnostic read names the status.
 */
export async function cancelJob(projectId: string, id: string): Promise<CancelJobResult> {
  const rows = await db
    .update(jobs)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.projectId, projectId), eq(jobs.status, "pending")))
    .returning();
  if (rows[0]) return { ok: true, job: rows[0] };
  const [existing] = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.projectId, projectId)))
    .limit(1);
  if (!existing) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "not_pending", status: existing.status };
}

export interface ListJobsFilter {
  kind?: string;
  status?: JobStatus;
  limit?: number;
  offset?: number;
}

/** Paginated job list for a project (newest first), limit+1 hasMore idiom. */
export async function listJobs(
  projectId: string,
  filter: ListJobsFilter = {},
): Promise<{ jobs: Job[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
  const offset = Math.max(filter.offset ?? 0, 0);
  const conds = [eq(jobs.projectId, projectId)];
  if (filter.kind) conds.push(eq(jobs.kind, filter.kind));
  if (filter.status) conds.push(eq(jobs.status, filter.status));
  const rows = await db
    .select()
    .from(jobs)
    .where(and(...conds))
    .orderBy(desc(jobs.createdAt))
    .limit(limit + 1)
    .offset(offset);
  return { jobs: rows.slice(0, limit), hasMore: rows.length > limit };
}
