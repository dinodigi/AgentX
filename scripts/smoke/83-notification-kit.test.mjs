import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql } from "./helpers.mjs";
import { NOTIFICATION_KIT_PLUGIN } from "../../plugins/notification-kit.mjs";

// Notification Kit plugin, end to end: global def visible + enableable, full
// baseline applies (announcements workflow + computed pref_key + partial-unique
// dedupe_key), and the acceptance criteria hold — pref uniqueness, idempotent
// sends, the unread absence-query, and the publish gate.
describe("Notification Kit plugin (in-app notifications)", () => {
  let p;
  let userId;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("notification-kit");
    await sql`
      INSERT INTO plugin_defs (id, project_id, definition, updated_at)
      VALUES (${NOTIFICATION_KIT_PLUGIN.id}, NULL, ${JSON.stringify(NOTIFICATION_KIT_PLUGIN)}::jsonb, now())
      ON CONFLICT (id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()`;
  });

  it("the GLOBAL def is in the catalog and enables", async () => {
    const list = await mcp(p.mcpToken, "list_plugins", {});
    assert.ok(list.value.some((x) => x.id === "notification_kit"), "notification_kit in the catalog");
    const e = await mcp(p.mcpToken, "enable_plugin", { id: "notification_kit" });
    assert.ok(e.ok, e.errorText);
    const g = await mcp(p.mcpToken, "get_plugin", { id: "notification_kit" });
    assert.equal(g.value.enabled, true);
    assert.equal(g.value.structure.baseline.length, 4);
  });

  it("APPLY: the full baseline defines cleanly on a fresh project", async () => {
    for (const c of NOTIFICATION_KIT_PLUGIN.structure.baseline) {
      const r = await mcp(p.mcpToken, "define_collection", {
        name: c.name,
        displayName: c.displayName,
        fields: c.fields,
        ...(c.workflow ? { workflow: c.workflow } : {}),
      });
      assert.ok(r.ok, `${c.name}: ${r.errorText}`);
    }
    const u = await mcp(p.mcpToken, "create_entry", {
      collection: "users",
      data: { email: "reader@example.com", name: "Reader" },
    });
    assert.ok(u.ok, u.errorText);
    userId = u.value.id;
  });

  it("prefs: one row per user+topic, DB-enforced by pref_key", async () => {
    const p1 = await mcp(p.mcpToken, "create_entry", {
      collection: "notification_prefs",
      data: { user: userId, topic: "billing", muted: true },
    });
    assert.ok(p1.ok, p1.errorText);
    const p2 = await mcp(p.mcpToken, "create_entry", {
      collection: "notification_prefs",
      data: { user: userId, topic: "billing", muted: false },
    });
    assert.equal(p2.ok, false, "duplicate user+topic pref must be rejected");
    assert.match(p2.errorText, /pref_key|unique/i, p2.errorText);
  });

  it("dedupe: unset repeats freely; a set dedupe_key can never double-send", async () => {
    const mk = (data) => mcp(p.mcpToken, "create_entry", { collection: "notifications", data });
    const a = await mk({ recipient: userId, kind: "info", topic: "comments", title: "New comment" });
    const b = await mk({ recipient: userId, kind: "info", topic: "comments", title: "New comment" });
    assert.ok(a.ok && b.ok, "repeatable notifications (no dedupe_key) must both insert");

    const key = `order_shipped|ord_1|${userId}`;
    const c = await mk({ recipient: userId, kind: "success", topic: "orders", title: "Shipped", dedupe_key: key });
    assert.ok(c.ok, c.errorText);
    const d = await mk({ recipient: userId, kind: "success", topic: "orders", title: "Shipped", dedupe_key: key });
    assert.equal(d.ok, false, "same dedupe_key must be rejected (idempotent send)");
    assert.match(d.errorText, /dedupe_key|unique/i, d.errorText);
  });

  it("unread: read_at exists:false is the badge query; marking read removes the row", async () => {
    const unread1 = await mcp(p.mcpToken, "count_entries", {
      collection: "notifications",
      where: [{ field: "read_at", op: "exists", value: false }],
    });
    assert.ok(unread1.ok, unread1.errorText);
    const before = unread1.value.count ?? unread1.value;
    assert.ok(before >= 3, `all sends start unread (got ${JSON.stringify(unread1.value)})`);

    const list = await mcp(p.mcpToken, "query_entries", {
      collection: "notifications",
      where: [{ field: "read_at", op: "exists", value: false }],
      limit: 1,
    });
    const target = list.value.entries[0];
    const mark = await mcp(p.mcpToken, "update_entry", {
      collection: "notifications",
      id: target.id,
      data: { read_at: new Date().toISOString() },
    });
    assert.ok(mark.ok, mark.errorText);

    const unread2 = await mcp(p.mcpToken, "count_entries", {
      collection: "notifications",
      where: [{ field: "read_at", op: "exists", value: false }],
    });
    const after = unread2.value.count ?? unread2.value;
    assert.equal(Number(after), Number(before) - 1, "marking read shrinks the unread set by one");
  });

  it("announcements: initial draft enforced; publish is a declared transition; draft→draft spoof rejected", async () => {
    const a = await mcp(p.mcpToken, "create_entry", {
      collection: "announcements",
      data: { title: "Maintenance window", kind: "warning", audience: "all" },
    });
    assert.ok(a.ok, a.errorText);
    assert.equal(a.value.data.status, "draft", "workflow initial applied");

    const sneak = await mcp(p.mcpToken, "create_entry", {
      collection: "announcements",
      data: { title: "Instant broadcast", status: "published" },
    });
    assert.equal(sneak.ok, false, "creating directly at published must be rejected");

    const pub = await mcp(p.mcpToken, "update_entry", {
      collection: "announcements", id: a.value.id, data: { status: "published" },
    });
    assert.ok(pub.ok, pub.errorText);
    const arch = await mcp(p.mcpToken, "update_entry", {
      collection: "announcements", id: a.value.id, data: { status: "archived" },
    });
    assert.ok(arch.ok, arch.errorText);
    const badBack = await mcp(p.mcpToken, "update_entry", {
      collection: "announcements", id: a.value.id, data: { status: "draft" },
    });
    assert.equal(badBack.ok, false, "archived→draft is not a declared transition");
  });
});
