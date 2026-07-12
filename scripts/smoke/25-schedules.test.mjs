import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import {
  ensureServer,
  createEphemeralProject,
  mcp,
  startWebhookReceiver,
  waitFor,
  BASE,
} from "./helpers.mjs";

// G3: recurring schedules — preset recurrence (UTC-only v1), drain-tick into
// dedupeKey'd schedule_fire jobs, run-time-truth skips (disabled/deleted/edited).
const sql = neon(process.env.DATABASE_URL);
const SECRET = process.env.CRON_SECRET;

async function drain() {
  const res = await fetch(`${BASE}/api/jobs/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  return { status: res.status, json: await res.json() };
}

describe("recurring schedules (G3)", () => {
  let p, receiver;
  before(async () => {
    await ensureServer();
    if (!SECRET || SECRET.length < 16) throw new Error("CRON_SECRET (>=16 chars) required in .env");
    p = await createEphemeralProject("schedules");
    receiver = await startWebhookReceiver();
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  it("define-time: recurrence presets are validated with fix-hints; UTC-only; no when/after", async () => {
    const noWeekday = await mcp(p.mcpToken, "define_schedule", {
      name: "bad1",
      recurrence: { frequency: "weekly" },
      action: { type: "webhook", url: receiver.url },
    });
    assert.ok(!noWeekday.ok && /weekday/.test(noWeekday.errorText), noWeekday.errorText);

    const dom29 = await mcp(p.mcpToken, "define_schedule", {
      name: "bad2",
      recurrence: { frequency: "monthly", dayOfMonth: 29 },
      action: { type: "webhook", url: receiver.url },
    });
    assert.ok(!dom29.ok, "dayOfMonth 29 must be rejected (1..28)");

    const tz = await mcp(p.mcpToken, "define_schedule", {
      name: "bad3",
      recurrence: { frequency: "daily", timezone: "Europe/Berlin" },
      action: { type: "webhook", url: receiver.url },
    });
    assert.ok(!tz.ok && /UTC-only/.test(tz.errorText), tz.errorText);

    const withWhen = await mcp(p.mcpToken, "define_schedule", {
      name: "bad4",
      recurrence: { frequency: "daily" },
      action: { type: "webhook", url: receiver.url, when: [{ field: "x", op: "eq", value: 1 }] },
    });
    assert.ok(!withWhen.ok && /no `when`\/`after`/.test(withWhen.errorText), withWhen.errorText);

    const email = await mcp(p.mcpToken, "define_schedule", {
      name: "bad5",
      recurrence: { frequency: "daily" },
      action: { type: "email", to: "a@b.c", subject: "s" },
    });
    assert.ok(!email.ok && /Resend/.test(email.errorText), email.errorText);
  });

  it("define → tick (rewound) → drain fires the webhook once and CAS-advances nextRunAt", async () => {
    const d = await mcp(p.mcpToken, "define_schedule", {
      name: "digest",
      recurrence: { frequency: "daily", at: "09:30" },
      action: { type: "webhook", url: receiver.url },
    });
    assert.ok(d.ok, d.errorText);
    const next = new Date(d.value.nextRunAt);
    assert.ok(next > new Date(), "nextRunAt must be in the future");
    assert.equal(next.getUTCHours(), 9);
    assert.equal(next.getUTCMinutes(), 30);

    // Make it due, then drain twice CONCURRENTLY: CAS-advance + dedupe key
    // guarantee exactly ONE fire regardless of how the two ticks race.
    await sql`UPDATE project_schedules SET next_run_at = now() - interval '1 minute'
      WHERE project_id = ${p.id} AND name = 'digest'`;
    const [r1, r2] = await Promise.all([drain(), drain()]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    // Re-drain while waiting: the concurrent ticks above CAS-advance + enqueue
    // the fire, but the just-enqueued job's run_at (app clock) can sit a few ms
    // ahead of Postgres's now() under clock skew, so neither concurrent drain
    // claims it in the same pass. In production the minute-ly cron drain claims
    // it on the next tick — mirror that here rather than assuming a single pass.
    // The CAS-advance + dedupe key still guarantee exactly ONE fire (asserted
    // below), so re-draining is safe.
    const hit = await waitFor(async () => {
      await drain();
      return receiver.received.find((r) => r.event === "schedule.fired" && r.schedule?.name === "digest");
    });
    assert.ok(hit, "schedule.fired webhook must arrive");
    assert.ok(hit.scheduledFor && hit.firedAt, "payload carries scheduledFor + firedAt");
    // Drain once more to flush any second (deduped→absent) job, then count.
    await drain();
    const fires = receiver.received.filter(
      (r) => r.event === "schedule.fired" && r.schedule?.name === "digest",
    );
    assert.equal(fires.length, 1, "exactly one fire per due window");

    const [row] = await sql`SELECT next_run_at, last_run_at FROM project_schedules
      WHERE project_id = ${p.id} AND name = 'digest'`;
    assert.ok(new Date(row.next_run_at) > new Date(), "nextRunAt advanced past now");
    assert.ok(row.last_run_at, "lastRunAt stamped");
  });

  it("a queued fire is SKIPPED if the schedule was disabled after enqueue (run-time truth)", async () => {
    const d = await mcp(p.mcpToken, "define_schedule", {
      name: "paused",
      recurrence: { frequency: "hourly" },
      action: { type: "webhook", url: receiver.url },
    });
    assert.ok(d.ok, d.errorText);
    const [s] = await sql`SELECT id, action FROM project_schedules WHERE project_id = ${p.id} AND name = 'paused'`;
    // Stage a queued fire (as the tick would), THEN pause the schedule.
    await sql`INSERT INTO jobs (project_id, kind, dedupe_key, payload) VALUES (
      ${p.id}, 'schedule_fire', ${"sched:" + s.id + ":test"},
      ${JSON.stringify({ scheduleId: s.id, name: "paused", action: s.action, scheduledFor: new Date().toISOString() })}::jsonb)`;
    const pause = await mcp(p.mcpToken, "define_schedule", {
      name: "paused",
      recurrence: { frequency: "hourly" },
      action: { type: "webhook", url: receiver.url },
      enabled: false,
    });
    assert.ok(pause.ok, pause.errorText);
    const r = await drain();
    assert.equal(r.status, 200);
    assert.ok(
      !receiver.received.some((x) => x.event === "schedule.fired" && x.schedule?.name === "paused"),
      "a paused schedule's queued fire must not send",
    );
  });

  it("a queued fire is SKIPPED if the action was edited after enqueue (hash mismatch)", async () => {
    const d = await mcp(p.mcpToken, "define_schedule", {
      name: "edited",
      recurrence: { frequency: "hourly" },
      action: { type: "webhook", url: receiver.url },
    });
    assert.ok(d.ok, d.errorText);
    const [s] = await sql`SELECT id FROM project_schedules WHERE project_id = ${p.id} AND name = 'edited'`;
    // Queued under the OLD action (different URL) — then the schedule was edited.
    await sql`INSERT INTO jobs (project_id, kind, payload) VALUES (
      ${p.id}, 'schedule_fire',
      ${JSON.stringify({ scheduleId: s.id, name: "edited", action: { type: "webhook", url: "https://old.example.com/hook" }, scheduledFor: new Date().toISOString() })}::jsonb)`;
    await drain();
    assert.ok(
      !receiver.received.some((x) => x.event === "schedule.fired" && x.schedule?.name === "edited"),
      "an edited-since-enqueue fire must not send",
    );
  });

  it("list_schedules + delete_schedule (returns the full spec for re-creation)", async () => {
    const list = await mcp(p.mcpToken, "list_schedules", {});
    assert.ok(list.ok, list.errorText);
    const digest = list.value.find((s) => s.name === "digest");
    assert.ok(digest && digest.enabled && digest.nextRunAt, "digest listed with nextRunAt");

    const del = await mcp(p.mcpToken, "delete_schedule", { name: "digest" });
    assert.ok(del.ok, del.errorText);
    assert.equal(del.value.deleted.recurrence.frequency, "daily");
    assert.equal(del.value.deleted.action.type, "webhook");

    const missing = await mcp(p.mcpToken, "delete_schedule", { name: "digest" });
    assert.ok(!missing.ok && /E_NOT_FOUND/.test(missing.errorText), missing.errorText);
  });
});
