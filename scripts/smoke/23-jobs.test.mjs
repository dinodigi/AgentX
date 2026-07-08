import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// G1: the shared pg jobs primitive — table, single-statement SKIP LOCKED claim,
// retry runner, fail-closed CRON_SECRET drain, list_jobs. Jobs are seeded via
// direct SQL (no declarative feature enqueues them until G2/G3), the same
// direct-seed idiom helpers.mjs uses for projects.
const sql = neon(process.env.DATABASE_URL);
const SECRET = process.env.CRON_SECRET;

async function drain(bearer) {
  const res = await fetch(`${BASE}/api/jobs/drain`, {
    method: "POST",
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

async function enqueueNoop(projectId, { dedupeKey, runAt } = {}) {
  const [row] = await sql`
    INSERT INTO jobs (project_id, kind, dedupe_key, run_at)
    VALUES (${projectId}, 'noop', ${dedupeKey ?? null}, ${runAt ?? new Date()})
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return row?.id ?? null;
}

describe("jobs: pg queue primitive (G1)", () => {
  let p;
  before(async () => {
    await ensureServer();
    if (!SECRET || SECRET.length < 16) {
      throw new Error("CRON_SECRET (>=16 chars) must be set in .env for the drain tests");
    }
    p = await createEphemeralProject("jobs");
  });
  after(async () => {
    await p.destroy();
  });

  it("enqueue → drain → succeeded (noop handler)", async () => {
    const id = await enqueueNoop(p.id);
    assert.ok(id, "enqueue should insert a job");
    const r = await drain(SECRET);
    assert.equal(r.status, 200);
    assert.ok(r.json.claimed >= 1 && r.json.succeeded >= 1, JSON.stringify(r.json));
    const [row] = await sql`SELECT status, attempts FROM jobs WHERE id = ${id}`;
    assert.equal(row.status, "succeeded");
    assert.equal(row.attempts, 1);
  });

  it("dedupeKey suppresses a second PENDING job of the same (project, kind, key)", async () => {
    const key = "dupe-" + p.id;
    const a = await enqueueNoop(p.id, { dedupeKey: key });
    const b = await enqueueNoop(p.id, { dedupeKey: key });
    assert.ok(a, "first enqueue inserts");
    assert.equal(b, null, "second enqueue with the same key is suppressed");
  });

  it("dedupe is scoped by project — another project may hold the same key", async () => {
    const other = await createEphemeralProject("jobs-other");
    try {
      const key = "shared-key";
      const a = await enqueueNoop(p.id, { dedupeKey: key });
      const b = await enqueueNoop(other.id, { dedupeKey: key });
      assert.ok(a && b, "same dedupeKey in two projects must both insert (no cross-tenant suppression)");
    } finally {
      await other.destroy();
    }
  });

  it("list_jobs (MCP) lists the project's jobs, filterable by status", async () => {
    const all = await mcp(p.mcpToken, "list_jobs", {});
    assert.ok(all.ok, all.errorText);
    assert.ok(Array.isArray(all.value.jobs));
    const succeeded = await mcp(p.mcpToken, "list_jobs", { status: "succeeded" });
    assert.ok(succeeded.value.jobs.every((j) => j.status === "succeeded"));
  });

  it("drain auth is FAIL-CLOSED: wrong secret, missing bearer, and 'Bearer undefined' all 401", async () => {
    const wrong = await drain("definitely-not-the-secret-value");
    assert.equal(wrong.status, 401);
    const missing = await drain(undefined);
    assert.equal(missing.status, 401);
    // The classic `Bearer ${env}` bug degrades to this literal when the env is unset.
    const literal = await drain("undefined");
    assert.equal(literal.status, 401);
  });

  it("dedupe covers IN-FLIGHT jobs: no duplicate admitted while one is running (queue-wedge fix)", async () => {
    // Regression for the review-confirmed wedge: if dedupe only covered 'pending',
    // a duplicate could slip in while the original runs, and the original's
    // running→pending reschedule would then collide → unique_violation + stall.
    const key = "inflight-" + p.id;
    const a = await enqueueNoop(p.id, { dedupeKey: key });
    assert.ok(a, "first enqueue inserts");
    // Simulate a claim: pending → running (leaves the pending-only scope).
    await sql`UPDATE jobs SET status = 'running', claimed_at = now() WHERE id = ${a}`;
    // A duplicate enqueued while the original is RUNNING must still be suppressed.
    const b = await enqueueNoop(p.id, { dedupeKey: key });
    assert.equal(b, null, "duplicate must be suppressed while the original is running");
    // The original can reschedule running → pending with NO unique collision.
    await sql`UPDATE jobs SET status = 'pending', claimed_at = NULL WHERE id = ${a}`;
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${a}`;
    assert.equal(row.status, "pending", "running→pending reschedule must not collide");
  });

  it("a future-dated job is not claimed until its run_at", async () => {
    const id = await enqueueNoop(p.id, { runAt: new Date(Date.now() + 60_000) });
    await drain(SECRET);
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
    assert.equal(row.status, "pending", "a not-yet-due job must remain pending");
  });

  it("cancel_job: a canceled pending job never runs; non-pending is E_CONFLICT (G5)", async () => {
    const id = await enqueueNoop(p.id, { runAt: new Date(Date.now() + 3600_000) });
    const c = await mcp(p.mcpToken, "cancel_job", { id });
    assert.ok(c.ok, c.errorText);
    assert.equal(c.value.status, "canceled");
    // Make it "due" — a canceled job must still never be claimed.
    await sql`UPDATE jobs SET run_at = now() - interval '1 minute' WHERE id = ${id}`;
    await drain(SECRET);
    const [row] = await sql`SELECT status, attempts FROM jobs WHERE id = ${id}`;
    assert.equal(row.status, "canceled");
    assert.equal(row.attempts, 0, "a canceled job never ran");
    // Canceling it again (not pending) → E_CONFLICT naming the status.
    const again = await mcp(p.mcpToken, "cancel_job", { id });
    assert.ok(!again.ok && /already canceled/.test(again.errorText), again.errorText);
    // Unknown id → E_NOT_FOUND.
    const missing = await mcp(p.mcpToken, "cancel_job", { id: "00000000-0000-4000-8000-000000000000" });
    assert.ok(!missing.ok && /E_NOT_FOUND/.test(missing.errorText), missing.errorText);
  });
});
