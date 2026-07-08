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

// G2: delayed event actions — `after` on EventAction enqueues an event_action
// job; at SEND time the action is re-resolved from CURRENT config and `when`
// re-evaluated against the CURRENT entry (config edit = kill switch).
const sql = neon(process.env.DATABASE_URL);
const SECRET = process.env.CRON_SECRET;

async function drain() {
  const res = await fetch(`${BASE}/api/jobs/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  return { status: res.status, json: await res.json() };
}

/** The event_action job for an entry (enqueue is deferred — poll for it). */
async function jobForEntry(entryId) {
  return waitFor(async () => {
    const [row] = await sql`
      SELECT id, status, run_at FROM jobs
      WHERE kind = 'event_action' AND payload->>'entryId' = ${entryId}`;
    return row ?? null;
  });
}

async function rewind(jobId) {
  await sql`UPDATE jobs SET run_at = now() - interval '1 minute' WHERE id = ${jobId}`;
}

const DELAYED_ACTION = (url) => ({
  type: "webhook",
  url,
  after: "1h",
  when: [{ field: "status", op: "eq", value: "open" }],
});

describe("delayed event actions (G2)", () => {
  let p, receiver;
  const defineTickets = (events) =>
    mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "status", label: "S", type: "text", publicRead: true },
      ],
      events,
    });

  before(async () => {
    await ensureServer();
    if (!SECRET || SECRET.length < 16) throw new Error("CRON_SECRET (>=16 chars) required in .env");
    p = await createEphemeralProject("delayed");
    receiver = await startWebhookReceiver();
    const d = await defineTickets({ created: [DELAYED_ACTION(receiver.url)] });
    assert.ok(d.ok, d.errorText);
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  it("define-time: a malformed `after` is rejected with the accepted units", async () => {
    const bad = await mcp(p.mcpToken, "define_collection", {
      name: "bad_after",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
      events: { created: [{ type: "webhook", url: "https://example.com/h", after: "3w" }] },
    });
    assert.ok(!bad.ok, "after:'3w' must be rejected");
    assert.match(bad.errorText, /after/);
    const overflow = await mcp(p.mcpToken, "define_collection", {
      name: "bad_after2",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
      events: { created: [{ type: "webhook", url: "https://example.com/h", after: "9000d" }] },
    });
    assert.ok(!overflow.ok && /365d/.test(overflow.errorText), overflow.errorText);
  });

  it("after:'1h' enqueues a future job; rewound + drained, the webhook is delivered", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "a", status: "open" } });
    assert.ok(c.ok, c.errorText);
    const job = await jobForEntry(c.value.id);
    assert.ok(job, "an event_action job should be enqueued");
    assert.equal(job.status, "pending");
    assert.ok(new Date(job.run_at) > new Date(Date.now() + 50 * 60_000), "run_at ≈ 1h out");
    assert.ok(!receiver.received.some((r) => r.entry?.id === c.value.id), "nothing sent before due time");

    await rewind(job.id);
    const d = await drain();
    assert.equal(d.status, 200);
    const hit = await waitFor(() =>
      receiver.received.find((r) => r.event === "entry.created" && r.entry?.id === c.value.id),
    );
    assert.ok(hit, "delayed webhook must be delivered after drain");
    assert.equal(hit.delayed?.after, "1h", "payload marks the delayed send");
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${job.id}`;
    assert.equal(row.status, "succeeded");
  });

  it("`when` is re-evaluated at send time: a flipped entry skips (job still succeeds)", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "b", status: "open" } });
    const job = await jobForEntry(c.value.id);
    // The entry stops matching `when` before the timer fires.
    const u = await mcp(p.mcpToken, "update_entry", { collection: "tickets", id: c.value.id, data: { status: "closed" } });
    assert.ok(u.ok, u.errorText);
    await rewind(job.id);
    await drain();
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${job.id}`;
    assert.equal(row.status, "succeeded", "skip-as-succeeded");
    assert.ok(!receiver.received.some((r) => r.entry?.id === c.value.id), "no send for a non-matching entry");
  });

  it("disabling the action before the timer fires cancels the pending send", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "c", status: "open" } });
    const job = await jobForEntry(c.value.id);
    // disabled is EXCLUDED from the action hash — same identity, paused.
    const re = await defineTickets({ created: [{ ...DELAYED_ACTION(receiver.url), disabled: true }] });
    assert.ok(re.ok, re.errorText);
    await rewind(job.id);
    await drain();
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${job.id}`;
    assert.equal(row.status, "succeeded", "skip-as-succeeded");
    assert.ok(!receiver.received.some((r) => r.entry?.id === c.value.id), "disabled action must not send");
    await defineTickets({ created: [DELAYED_ACTION(receiver.url)] }); // restore
  });

  it("removing (or editing) the action orphans its queued jobs — config is the authority", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "d", status: "open" } });
    const job = await jobForEntry(c.value.id);
    const re = await defineTickets({ created: [] }); // action removed entirely
    assert.ok(re.ok, re.errorText);
    await rewind(job.id);
    await drain();
    const [row] = await sql`SELECT status FROM jobs WHERE id = ${job.id}`;
    assert.equal(row.status, "succeeded", "skip-as-succeeded");
    assert.ok(!receiver.received.some((r) => r.entry?.id === c.value.id), "removed action must not send");
    await defineTickets({ created: [DELAYED_ACTION(receiver.url)] }); // restore
  });

  it("dedupe: repeated matching events keep ONE pending send per (entry, event, action)", async () => {
    // An `updated` delayed action: two updates → one pending job (timer pinned
    // to the FIRST matching event; later updates don't reset or duplicate it).
    const re = await defineTickets({
      created: [DELAYED_ACTION(receiver.url)],
      updated: [{ type: "webhook", url: receiver.url, after: "2h" }],
    });
    assert.ok(re.ok, re.errorText);
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "e", status: "open" } });
    await mcp(p.mcpToken, "update_entry", { collection: "tickets", id: c.value.id, data: { title: "e1" } });
    await mcp(p.mcpToken, "update_entry", { collection: "tickets", id: c.value.id, data: { title: "e2" } });
    await waitFor(async () => {
      const rows = await sql`
        SELECT id FROM jobs WHERE kind = 'event_action'
        AND payload->>'entryId' = ${c.value.id} AND payload->>'event' = 'updated'`;
      return rows.length >= 1 ? rows : null;
    });
    const rows = await sql`
      SELECT id FROM jobs WHERE kind = 'event_action'
      AND payload->>'entryId' = ${c.value.id} AND payload->>'event' = 'updated' AND status = 'pending'`;
    assert.equal(rows.length, 1, "exactly one pending delayed send per (entry, event, action)");
  });

  it("list_jobs shows the pending delayed send with its display-only enqueuedAction", async () => {
    const r = await mcp(p.mcpToken, "list_jobs", { kind: "event_action", status: "pending" });
    assert.ok(r.ok, r.errorText);
    assert.ok(r.value.jobs.length >= 1);
    assert.equal(r.value.jobs[0].payload.enqueuedAction.type, "webhook");
  });
});
