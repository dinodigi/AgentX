import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  mcp,
  delivery,
  startWebhookReceiver,
  waitFor,
} from "./helpers.mjs";

describe("trash: recoverable delete + restore (C1)", () => {
  let p, receiver;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("trash");
    receiver = await startWebhookReceiver();
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "Title", type: "text", required: true, publicRead: true }],
      events: { created: [{ type: "webhook", url: receiver.url }] },
    });
    assert.ok(def.ok, def.errorText);
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  const make = async (title) => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title } });
    assert.ok(r.ok, r.errorText);
    return r.value.id;
  };

  it("delete → invisible everywhere; list_trash shows it; restore → reappears with restored event", async () => {
    const id = await make("Recoverable");
    receiver.received.length = 0;

    const del = await mcp(p.mcpToken, "delete_entry", { collection: "posts", id });
    assert.ok(del.ok, del.errorText);

    // Gone from MCP query, count, get, and the delivery API.
    const q = await mcp(p.mcpToken, "query_entries", { collection: "posts" });
    assert.ok(!q.value.entries.some((e) => e.id === id), "trashed row must not appear in query");
    const got = await mcp(p.mcpToken, "get_entry", { collection: "posts", id });
    assert.ok(!got.ok, "get_entry on a trashed row is not found");
    const live = await delivery(p.deliveryToken, "/posts");
    assert.ok(!live.json.data.some((e) => e.id === id), "trashed row must not be served publicly");

    // Visible in trash.
    const trash = await mcp(p.mcpToken, "list_trash", {});
    const trashed = trash.value.rows.find((r) => r.id === id);
    assert.ok(trashed, "row should be in trash: " + JSON.stringify(trash.value));
    assert.equal(trashed.collection, "posts");
    assert.equal(trashed.data.title, "Recoverable");
    assert.equal(trashed.deletedBy.type, "mcp");

    // Restore → same id, reappears everywhere.
    const restored = await mcp(p.mcpToken, "restore_entry", { collection: "posts", id });
    assert.ok(restored.ok, restored.errorText);
    assert.equal(restored.value.id, id);
    const got2 = await mcp(p.mcpToken, "get_entry", { collection: "posts", id });
    assert.ok(got2.ok && got2.value.data.title === "Recoverable", "restored entry reappears");
    const live2 = await delivery(p.deliveryToken, "/posts");
    assert.ok(live2.json.data.some((e) => e.id === id), "restored row served publicly again");

    // Restore re-emits entry.created with restored:true.
    const hit = await waitFor(() =>
      receiver.received.find((r) => r.event === "entry.created" && r.entry?.id === id && r.restored),
    );
    assert.ok(hit, "restore should emit entry.created with restored:true");
    assert.equal(hit.restored, true);
    assert.ok(hit.deletedAt, "restored event carries the deletedAt");

    // No longer in trash.
    const trash2 = await mcp(p.mcpToken, "list_trash", {});
    assert.ok(!trash2.value.rows.some((r) => r.id === id), "restored row leaves trash");
  });

  it("restore of an unknown id is E_NOT_FOUND", async () => {
    const r = await mcp(p.mcpToken, "restore_entry", {
      collection: "posts",
      id: "00000000-0000-4000-8000-000000000000",
    });
    assert.ok(!r.ok && /\[E_NOT_FOUND\]/.test(r.errorText), r.errorText);
  });

  it("delete via transact also trashes (uniform through the core)", async () => {
    const id = await make("Batch-deleted");
    const t = await mcp(p.mcpToken, "transact", {
      ops: [{ op: "delete", collection: "posts", id }],
    });
    assert.ok(t.ok, t.errorText);
    const trash = await mcp(p.mcpToken, "list_trash", {});
    assert.ok(trash.value.rows.some((r) => r.id === id), "transact delete should trash the row");
  });

  it("get_audit_log records a restore action", async () => {
    const id = await make("Audited");
    await mcp(p.mcpToken, "delete_entry", { collection: "posts", id });
    await mcp(p.mcpToken, "restore_entry", { collection: "posts", id });
    const log = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "get_audit_log", { collection: "posts", action: "restore" });
      return r.ok && r.value.audit?.some((e) => e.entryId === id) ? r.value : null;
    });
    assert.ok(log, "audit log should record the restore");
  });

  it("asset gate: a trashed entry still pins its asset with a distinct hint", async () => {
    const up = await mcp(p.mcpToken, "upload_asset", {
      filename: "pin.txt",
      contentType: "text/plain",
      dataBase64: Buffer.from("pin").toString("base64"),
    });
    assert.ok(up.ok, up.errorText);
    const assetId = up.value.id;

    await mcp(p.mcpToken, "define_collection", {
      name: "gallery",
      fields: [{ name: "img", label: "Img", type: "asset" }],
    });
    const entry = await mcp(p.mcpToken, "create_entry", { collection: "gallery", data: { img: assetId } });
    assert.ok(entry.ok, entry.errorText);

    // Live reference blocks with the plain hint.
    const blockedLive = await mcp(p.mcpToken, "delete_asset", { id: assetId });
    assert.ok(!blockedLive.ok && /\[E_BLOCKED\]/.test(blockedLive.errorText), blockedLive.errorText);
    assert.match(blockedLive.errorText, /entries still reference/);

    // Trash the entry — now the block comes from the TRASH scan with its own hint.
    await mcp(p.mcpToken, "delete_entry", { collection: "gallery", id: entry.value.id });
    const blockedTrash = await mcp(p.mcpToken, "delete_asset", { id: assetId });
    assert.ok(!blockedTrash.ok && /\[E_BLOCKED\]/.test(blockedTrash.errorText), blockedTrash.errorText);
    assert.match(blockedTrash.errorText, /trashed entries still reference/);
  });
});

import { neon } from "@neondatabase/serverless";
const rawSql = neon(process.env.DATABASE_URL);

describe("trash: purge, empty, retention (C2)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("purge");
    await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      fields: [{ name: "title", label: "Title", type: "text", required: true, publicRead: true }],
    });
  });
  after(() => p.destroy());

  const makeTrashed = async (title) => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title } });
    assert.ok(c.ok, c.errorText);
    await mcp(p.mcpToken, "delete_entry", { collection: "docs", id: c.value.id });
    return c.value.id;
  };

  it("purge_entry: plan without confirm, permanent with confirm, then restore is E_NOT_FOUND", async () => {
    const id = await makeTrashed("purge-me");
    const plan = await mcp(p.mcpToken, "purge_entry", { collection: "docs", id });
    assert.ok(plan.ok, plan.errorText);
    assert.equal(plan.value.requiresConfirmation, true);
    assert.equal(plan.value.code, "E_CONFIRM_REQUIRED");
    assert.equal(typeof plan.value.plan.inboundRefCount, "number");
    assert.ok(Array.isArray(plan.value.plan.assetsFreed));

    const done = await mcp(p.mcpToken, "purge_entry", { collection: "docs", id, confirm: true });
    assert.ok(done.ok && done.value.purged === true, done.errorText);

    const restore = await mcp(p.mcpToken, "restore_entry", { collection: "docs", id });
    assert.ok(!restore.ok && /\[E_NOT_FOUND\]/.test(restore.errorText), restore.errorText);
    const trash = await mcp(p.mcpToken, "list_trash", {});
    assert.ok(!trash.value.rows.some((r) => r.id === id), "purged row gone from trash");
  });

  it("empty_trash: plan counts, confirm removes all", async () => {
    await makeTrashed("e1");
    await makeTrashed("e2");
    const plan = await mcp(p.mcpToken, "empty_trash", { collection: "docs" });
    assert.ok(plan.ok && plan.value.requiresConfirmation, plan.errorText);
    assert.ok(plan.value.plan.count >= 2, JSON.stringify(plan.value.plan));

    const done = await mcp(p.mcpToken, "empty_trash", { collection: "docs", confirm: true });
    assert.ok(done.ok && done.value.emptied === true, done.errorText);
    assert.ok(done.value.purged >= 2, JSON.stringify(done.value));
    const trash = await mcp(p.mcpToken, "list_trash", {});
    assert.equal(trash.value.rows.length, 0, "trash empty for this project");
  });

  it("retention: a row deleted >30 days ago is swept on list_trash", async () => {
    const id = await makeTrashed("ancient");
    // Backdate its deletedAt beyond the 30-day window.
    await rawSql`UPDATE entries_trash SET deleted_at = now() - interval '40 days' WHERE id = ${id}`;
    // list_trash defers a sweep; call it, then poll until the row is gone.
    await mcp(p.mcpToken, "list_trash", {});
    const swept = await waitFor(async () => {
      const rows = await rawSql`SELECT id FROM entries_trash WHERE id = ${id}`;
      return rows.length === 0 ? true : null;
    });
    assert.ok(swept, "backdated trash row should be swept");
  });

  it("delete_collection plan surfaces trashedEntries", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "temp",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
    });
    const c = await mcp(p.mcpToken, "create_entry", { collection: "temp", data: { x: "a" } });
    await mcp(p.mcpToken, "delete_entry", { collection: "temp", id: c.value.id });
    const plan = await mcp(p.mcpToken, "delete_collection", { name: "temp" });
    assert.ok(plan.ok && plan.value.requiresConfirmation, JSON.stringify(plan.value));
    assert.equal(plan.value.plan.trashedEntries, 1, JSON.stringify(plan.value.plan));
  });

  it("rename backfills trashed rows: restore after a rename lands under the new key", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "renamable",
      fields: [{ name: "old_name", label: "Old", type: "text", required: true }],
    });
    const c = await mcp(p.mcpToken, "create_entry", { collection: "renamable", data: { old_name: "keep" } });
    await mcp(p.mcpToken, "delete_entry", { collection: "renamable", id: c.value.id });
    // Rename the field while the row is in trash.
    const rn = await mcp(p.mcpToken, "define_collection", {
      name: "renamable",
      fields: [{ name: "new_name", label: "New", type: "text", required: true }],
      renames: [{ from: "old_name", to: "new_name" }],
    });
    assert.ok(rn.ok, rn.errorText);
    // Restore — the data must be under the new key (or strict validation would reject it).
    const restored = await mcp(p.mcpToken, "restore_entry", { collection: "renamable", id: c.value.id });
    assert.ok(restored.ok, restored.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "renamable", id: c.value.id });
    assert.equal(got.value.data.new_name, "keep");
    assert.ok(!("old_name" in got.value.data));
  });
});
