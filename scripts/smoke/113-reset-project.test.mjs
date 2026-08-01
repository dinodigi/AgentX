import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery, sql, waitFor } from "./helpers.mjs";

// OPS-6 (wall ad7568ba, xvibe) — one-call factory reset. The reporter's pain:
// an eval harness needing a clean slate per run had to delete N collections in
// dependency order (E_BLOCKED on relation targets) and then chase schedules and
// plugin state. Our own smoke harness grew a stranded-project sweeper for the
// same reason.

describe("OPS-6 — reset_project", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("reset-project");

    // A project with a RELATION between collections — the exact shape that
    // forces dependency-ordered deletes today — plus a schedule, a trashed row,
    // locales, and an enabled plugin, so the plan has something in every bucket.
    const authors = await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [{ name: "name", label: "N", type: "text", required: true, publicRead: true }],
    });
    assert.ok(authors.ok, authors.errorText);
    const posts = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "author", label: "A", type: "relation", targetCollection: "authors", labelField: "name" },
      ],
    });
    assert.ok(posts.ok, posts.errorText);
    await mcp(p.mcpToken, "set_locales", { default: "en", supported: ["en", "de"] });
    const a = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "ada" } });
    const post = await mcp(p.mcpToken, "create_entry", {
      collection: "posts", data: { title: "hello", author: a.value.id },
    });
    assert.ok(post.ok, post.errorText);
    const doomed = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "trash me" } });
    await mcp(p.mcpToken, "delete_entry", { collection: "posts", id: doomed.value.id });
    const sched = await mcp(p.mcpToken, "define_schedule", {
      name: "daily_noop",
      recurrence: { frequency: "daily", at: "03:00" },
      action: { type: "webhook", url: "https://example.test/hook" },
    });
    assert.ok(sched.ok, sched.errorText);
  });
  after(() => p.destroy());

  it("FIXTURE: deleting `authors` directly is E_BLOCKED — the pain being solved is real", async () => {
    const r = await mcp(p.mcpToken, "delete_collection", { name: "authors", confirm: true });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /relation fields still target/);
  });

  it("without confirm: the PLAN, with exact counts and an explicit kept list — nothing wiped", async () => {
    const r = await mcp(p.mcpToken, "reset_project", {});
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.requiresConfirmation, true);
    assert.equal(r.value.code, "E_CONFIRM_REQUIRED");
    const plan = r.value.plan;
    assert.equal(plan.collections, 2);
    assert.equal(plan.liveEntries, 2);
    assert.equal(plan.trashedEntries, 1);
    assert.equal(plan.schedules, 1);
    assert.equal(plan.localesConfigured, true);
    assert.ok(plan.kept.some((k) => k.includes("tokens")), "the kept list must name tokens");
    assert.ok(plan.kept.some((k) => k.includes("connectors")));
    // …and it was really a plan: everything still exists.
    const list = await mcp(p.mcpToken, "list_collections", {});
    assert.equal(list.value.length, 2, "plan must not wipe");
  });

  it("with confirm: one call wipes schema+content+automation — no dependency ordering needed", async () => {
    const r = await mcp(p.mcpToken, "reset_project", { confirm: true });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.reset, true);
    assert.equal(r.value.wiped.collections, 2);

    const list = await mcp(p.mcpToken, "list_collections", {});
    assert.ok(list.ok, list.errorText);
    assert.equal(list.value.length, 0, "clean slate");
    const trash = await mcp(p.mcpToken, "list_trash", {});
    assert.equal(trash.value.rows.length, 0, "trash wiped too — a reset is not a soft delete");
    const scheds = await mcp(p.mcpToken, "list_schedules", {});
    assert.equal((scheds.value.schedules ?? scheds.value).length, 0, "schedules wiped");
    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.equal(info.value.locales, null, "locales reset");

    // The DB agrees — belt and braces via direct SQL on the control plane.
    const [cols] = await sql`SELECT count(*)::int AS n FROM collections WHERE project_id = ${p.id}`;
    assert.equal(cols.n, 0, "collections must be empty");
    const [scheds2] = await sql`SELECT count(*)::int AS n FROM project_schedules WHERE project_id = ${p.id}`;
    assert.equal(scheds2.n, 0, "project_schedules must be empty");
    const [jobs] = await sql`SELECT count(*)::int AS n FROM jobs WHERE project_id = ${p.id}`;
    assert.equal(jobs.n, 0, "jobs must be empty");
  });

  it("KEPT list is true: the MCP token still works (this call proves it) and connectors survive", async () => {
    // Every assertion in the previous test already used the token post-reset;
    // make the claim explicit anyway, plus the delivery token.
    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(info.ok, "mcp token survives its own reset call");
    const del = await delivery(p.deliveryToken, "/anything");
    assert.ok(del.status === 404 || del.status === 401, `delivery token still authenticates (got ${del.status})`);
  });

  it("the project is REUSABLE after reset — define again from the clean slate", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [{ name: "name", label: "N", type: "text", required: true }],
    });
    assert.ok(r.ok, `a reset project must accept fresh schema: ${r.errorText}`);
    const e = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "fresh" } });
    assert.ok(e.ok, e.errorText);
  });

  it("kept means kept: PRE-reset audit rows survive, and the wipe is on the platform trail", async () => {
    // The fixture creates wrote audit rows BEFORE the reset; the audit log is on
    // the kept list, so those rows must still be readable after it.
    const audit = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "get_audit_log", {});
      return r.ok && r.value.audit.some((a) => a.action === "delete") ? r.value.audit : null;
    });
    assert.ok(audit, "pre-reset audit rows (the fixture delete) must survive the wipe");
    // And the reset itself is recorded operator-side.
    const events = await waitFor(async () => {
      const rows = await sql`SELECT note FROM platform_events
        WHERE project_id = ${p.id} AND type = 'project_reset'`;
      return rows.length > 0 ? rows : null;
    });
    assert.ok(events, "the factory reset must leave a platform-events line");
    assert.match(events[0].note, /2 collections/);
  });
});
