import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql, BASE } from "./helpers.mjs";

// Plugin Bases Plan, Track B (AUTO-1): declarative scheduled mutations — the
// recycle sweep self-hosts. Closed vocabulary: where (relative times), guard
// (CAS at write), transition (mcp actor), set (now|null|{value}|{copyFrom}).
const SECRET = process.env.CRON_SECRET;

async function drain() {
  const res = await fetch(`${BASE}/api/jobs/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
  return { status: res.status, json: await res.json() };
}

const daysAgoIso = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

describe("declarative scheduled mutations (AUTO-1)", () => {
  let p, stale, guarded, fresh;
  const SCHED = "recycle-sweep";

  before(async () => {
    await ensureServer();
    if (!SECRET || SECRET.length < 16) throw new Error("CRON_SECRET (>=16 chars) required in .env");
    p = await createEphemeralProject("auto1");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [
        { name: "who", label: "Who", type: "text", required: true },
        { name: "owner", label: "Owner", type: "text" },
        { name: "previous_owner", label: "Prev owner", type: "text" },
        { name: "protected_flag", label: "Protected", type: "boolean" },
        { name: "last_kit_at", label: "Last KIT", type: "date" },
        { name: "status", label: "S", type: "enum", options: ["new", "kit", "unprotected"] },
      ],
      workflow: {
        field: "status",
        initial: "new",
        transitions: [
          { from: "new", to: "kit", actors: ["mcp", "admin"] },
          { from: ["new", "kit"], to: "unprotected", actors: ["mcp", "admin"] },
          { from: "unprotected", to: "new", actors: ["mcp", "admin"] },
        ],
      },
    });
    assert.ok(def.ok, def.errorText);

    const mk = (data) =>
      mcp(p.mcpToken, "create_entry", { collection: "leads", data, allowExplicitWorkflowState: true });
    stale = (await mk({ who: "stale", owner: "rep_1", last_kit_at: daysAgoIso(40), status: "kit" })).value;
    guarded = (await mk({ who: "guarded", owner: "rep_2", protected_flag: true, last_kit_at: daysAgoIso(35), status: "kit" })).value;
    fresh = (await mk({ who: "fresh", owner: "rep_3", last_kit_at: daysAgoIso(5), status: "kit" })).value;
  });
  after(() => p.destroy());

  it("define-time validation: the closed vocabulary is enforced", async () => {
    const cases = [
      [{ collection: "ghosts", where: [{ field: "x", op: "eq", value: 1 }], transition: { to: "unprotected" } }, /unknown collection/i],
      [{ collection: "leads", where: [], transition: { to: "unprotected" } }, /at least one clause/i],
      [{ collection: "leads", where: [{ field: "status", op: "eq", value: "kit" }], set: { status: { value: "unprotected" } } }, /workflow field/i],
      [{ collection: "leads", where: [{ field: "last_kit_at", op: "before", value: "x" }], transition: { to: "unprotected" } }, /op "before"/i],
      [{ collection: "leads", where: [{ field: "who", op: "eq", value: "x" }], transition: { to: "nowhere" } }, /not a transition target/i],
      [{ collection: "leads", where: [{ field: "who", op: "eq", value: "x" }], set: { previous_owner: { copyFrom: "ghost_field" } } }, /closed/i],
    ];
    for (const [action, re] of cases) {
      const r = await mcp(p.mcpToken, "define_schedule", {
        name: "bad-sweep",
        recurrence: { frequency: "hourly" },
        action: { type: "mutate", ...action },
      });
      assert.equal(r.ok, false, JSON.stringify(action));
      assert.match(r.errorText, re, r.errorText);
    }
  });

  it("the sweep: stale rows transition + stamp; guard and freshness protect the rest", async () => {
    const r = await mcp(p.mcpToken, "define_schedule", {
      name: SCHED,
      recurrence: { frequency: "hourly" },
      action: {
        type: "mutate",
        collection: "leads",
        where: [
          { field: "last_kit_at", op: "lt", value: { daysAgo: 30 } },
          { field: "status", op: "in", value: ["kit"] },
        ],
        guard: [
          { field: "status", op: "eq", value: "kit" },
          { field: "protected_flag", op: "exists", value: false },
        ],
        transition: { to: "unprotected" },
        set: { previous_owner: { copyFrom: "owner" }, owner: null },
      },
    });
    assert.ok(r.ok, r.errorText);

    await sql`UPDATE project_schedules SET next_run_at = now() - interval '1 second'
              WHERE project_id = ${p.id} AND name = ${SCHED}`;
    const d = await drain();
    assert.equal(d.status, 200, JSON.stringify(d.json));

    const get = async (id) => (await mcp(p.mcpToken, "get_entry", { collection: "leads", id })).value.data;
    const s = await get(stale.id);
    assert.equal(s.status, "unprotected", "stale row transitioned");
    assert.equal(s.previous_owner, "rep_1", "copyFrom stamped before the clear");
    assert.equal(s.owner, undefined, "owner unset");

    const g = await get(guarded.id);
    assert.equal(g.status, "kit", "guarded row skipped (protected_flag exists)");
    assert.equal(g.owner, "rep_2", "guarded row untouched");

    const f = await get(fresh.id);
    assert.equal(f.status, "kit", "fresh row untouched (relative cutoff)");
  });

  it("audit attribution: the sweep's writes carry the schedule name", async () => {
    let row = null;
    for (let i = 0; i < 12 && !row; i++) {
      const log = await mcp(p.mcpToken, "get_audit_log", { collection: "leads", entryId: stale.id });
      row = (log.value?.audit ?? []).find((a) => a.action === "update" && a.actor?.schedule === SCHED) ?? null;
      if (!row) await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(row, "audit update row with actor.schedule present");
    assert.equal(row.actor.type, "mcp");
  });

  it("idempotent + exactly-once: concurrent re-drains do not double-apply", async () => {
    await sql`UPDATE project_schedules SET next_run_at = now() - interval '1 second'
              WHERE project_id = ${p.id} AND name = ${SCHED}`;
    const [d1, d2] = await Promise.all([drain(), drain()]);
    assert.equal(d1.status, 200);
    assert.equal(d2.status, 200);
    const s = (await mcp(p.mcpToken, "get_entry", { collection: "leads", id: stale.id })).value.data;
    assert.equal(s.status, "unprotected", "still exactly at target");
    assert.equal(s.previous_owner, "rep_1", "stamp not overwritten by a second pass");
    // Exactly one schedule-attributed update ever landed on the stale row.
    const log = await mcp(p.mcpToken, "get_audit_log", { collection: "leads", entryId: stale.id });
    const swept = (log.value?.audit ?? []).filter((a) => a.actor?.schedule === SCHED);
    assert.equal(swept.length, 1, JSON.stringify(swept));
  });
});
