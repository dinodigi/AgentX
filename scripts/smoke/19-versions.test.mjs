import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  mcp,
  startWebhookReceiver,
  waitFor,
} from "./helpers.mjs";

describe("entry versions: snapshots + restore (C4/C5/C6/C8)", () => {
  let p, receiver;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("versions");
    receiver = await startWebhookReceiver();
    await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "seats", label: "Seats", type: "number", min: 0 },
      ],
      events: { updated: [{ type: "webhook", url: receiver.url }] },
    });
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  it("C4: two updates leave two pre-image snapshots, newest first", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "v0" } });
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "docs", id, data: { title: "v1" } });
    await mcp(p.mcpToken, "update_entry", { collection: "docs", id, data: { title: "v2" } });

    const vs = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "docs", id });
      return r.ok && r.value.versions.length >= 2 ? r.value : null;
    });
    assert.ok(vs, "should have 2 snapshots");
    // Newest first: the snapshot BEFORE the "v2" update holds "v1"; before "v1" holds "v0".
    assert.equal(vs.versions[0].data.title, "v1");
    assert.equal(vs.versions[1].data.title, "v0");
    assert.ok(vs.versions[0].changedFields.includes("title"));
  });

  it("C8: update_entry_if captures a pre-CAS snapshot and the updated event carries previous", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "cas", seats: 5 } });
    const id = c.value.id;
    receiver.received.length = 0;

    const cas = await mcp(p.mcpToken, "update_entry_if", {
      collection: "docs",
      id,
      if: [{ field: "seats", op: "gt", value: 0 }],
      increment: { field: "seats", by: -1 },
    });
    assert.ok(cas.ok, cas.errorText);

    const vs = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "docs", id });
      return r.ok && r.value.versions.length >= 1 ? r.value : null;
    });
    assert.equal(vs.versions[0].data.seats, 5, "pre-CAS snapshot has the old seat count");

    const hit = await waitFor(() =>
      receiver.received.find((r) => r.event === "entry.updated" && r.entry?.id === id),
    );
    assert.ok(hit?.previous, "CAS updated event carries previous");
    assert.equal(hit.previous.data.seats, 5);
    assert.ok(hit.changedFields.includes("seats"));
  });

  it("C6: restore_entry_version rolls the entry back and is itself undoable", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "orig" } });
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "docs", id, data: { title: "changed" } });

    const vs = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "docs", id });
      return r.ok && r.value.versions.length >= 1 ? r.value : null;
    });
    const origVersion = vs.versions.find((v) => v.data.title === "orig");
    assert.ok(origVersion, "should have the 'orig' snapshot");

    const restored = await mcp(p.mcpToken, "restore_entry_version", {
      collection: "docs",
      id,
      versionId: origVersion.versionId,
    });
    assert.ok(restored.ok, restored.errorText);
    assert.equal(restored.value.data.title, "orig");

    // The restore captured the pre-restore ("changed") state as a new version.
    const vs2 = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "docs", id });
      return r.ok && r.value.versions.some((v) => v.data.title === "changed") ? r.value : null;
    });
    assert.ok(vs2, "restore should be undoable (pre-restore snapshot captured)");
  });

  it("C6: unknown versionId is E_NOT_FOUND", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "x" } });
    const r = await mcp(p.mcpToken, "restore_entry_version", {
      collection: "docs",
      id: c.value.id,
      versionId: "00000000-0000-4000-8000-000000000000",
    });
    assert.ok(!r.ok && /\[E_NOT_FOUND\]/.test(r.errorText), r.errorText);
  });

  it("C4: history caps at 20 snapshots per entry", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "0" } });
    const id = c.value.id;
    for (let i = 1; i <= 24; i++) {
      await mcp(p.mcpToken, "update_entry", { collection: "docs", id, data: { title: String(i) } });
    }
    const capped = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "docs", id, limit: 100 });
      return r.ok && r.value.versions.length <= 20 ? r.value : null;
    });
    assert.ok(capped, "history should be pruned to <= 20");
    assert.equal(capped.versions.length, 20);
  });

  it("C5: purging a trashed entry reaps its version history", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "reap-0" } });
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "docs", id, data: { title: "reap-1" } });
    await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "docs", id });
      return r.value.versions.length >= 1 ? true : null;
    });

    await mcp(p.mcpToken, "delete_entry", { collection: "docs", id });
    const purged = await mcp(p.mcpToken, "purge_entry", { collection: "docs", id, confirm: true });
    assert.ok(purged.ok && purged.value.purged, purged.errorText);

    const gone = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "docs", id });
      return r.ok && r.value.versions.length === 0 ? true : null;
    });
    assert.ok(gone, "versions should be reaped on purge");
  });

  it("C4: transact update captures a version too", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "tx0" } });
    const id = c.value.id;
    const t = await mcp(p.mcpToken, "transact", {
      ops: [{ op: "update", collection: "docs", id, data: { title: "tx1" } }],
    });
    assert.ok(t.ok, t.errorText);
    const vs = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "docs", id });
      return r.ok && r.value.versions.some((v) => v.data.title === "tx0") ? r.value : null;
    });
    assert.ok(vs, "transact update should snapshot the pre-image");
  });
});
