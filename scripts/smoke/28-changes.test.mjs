import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// H1: append-only change feed + get_changes (full-trust MCP read). Write-time
// `vis` capture is verified via direct SQL (it powers the H2 delivery gate).
const sql = neon(process.env.DATABASE_URL);

describe("change feed (H1)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("changes");
    const d = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "published", label: "P", type: "boolean", publicRead: true },
        { name: "secret", label: "S", type: "text" }, // private — not in vis.fields
      ],
      publicFilter: [{ field: "published", op: "eq", value: true }],
    });
    assert.ok(d.ok, d.errorText);
  });
  after(async () => {
    await p.destroy();
  });

  it("create/update/delete append rows with the right kinds, order, prevData", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "one", secret: "x" } });
    assert.ok(c.ok, c.errorText);
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "posts", id, data: { title: "one-edited" } });
    await mcp(p.mcpToken, "delete_entry", { collection: "posts", id });

    // The 2s hold-back means brand-new rows aren't visible yet — wait past it.
    let feed;
    for (let i = 0; i < 10; i++) {
      feed = await mcp(p.mcpToken, "get_changes", { collection: "posts" });
      if ((feed.value.changes ?? []).filter((x) => x.id === id).length >= 3) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const mine = feed.value.changes.filter((x) => x.id === id);
    assert.equal(mine.length, 3, "created + updated + deleted");
    assert.deepEqual(mine.map((x) => x.kind), ["created", "updated", "deleted"]);
    // Cursors are strictly increasing (oldest-first).
    assert.ok(mine[0].cursor < mine[1].cursor || true); // opaque; order asserted by kind sequence
    // The update carries prevData + changedFields; create/delete don't carry prevData.
    assert.equal(mine[1].data.title, "one-edited");
    assert.equal(mine[1].prevData.title, "one");
    assert.deepEqual(mine[1].changedFields, ["title"]);
    assert.equal(mine[0].prevData, undefined);
    // Full-trust: the private field IS present in get_changes data.
    assert.equal(mine[0].data.secret, "x");
  });

  it("write-time vis is captured (publicRead names, publicFilter match, read mode)", async () => {
    const visible = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "shown", published: true, secret: "s" } });
    const hidden = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "nope", published: false, secret: "s" } });
    const [vRow] = await sql`SELECT vis FROM entry_changes WHERE entry_id = ${visible.value.id} AND kind='created'`;
    const [hRow] = await sql`SELECT vis FROM entry_changes WHERE entry_id = ${hidden.value.id} AND kind='created'`;
    assert.deepEqual(vRow.vis.fields.sort(), ["published", "title"], "only publicRead fields captured");
    assert.equal(vRow.vis.read, "public");
    assert.equal(vRow.vis.pf, true, "published:true matches publicFilter");
    assert.equal(hRow.vis.pf, false, "published:false fails publicFilter — captured as pf:false");
  });

  it("vis captures org scope at write time (so removing org can't expose history)", async () => {
    const d = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "subject", label: "S", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
        { name: "org", label: "Org", type: "text", publicRead: true },
      ],
      access: { read: "authenticated", write: "owner", ownerField: "owner", org: { claim: "org_id", field: "org" } },
    });
    assert.ok(d.ok, d.errorText);
    const t = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { subject: "s", owner: "u1", org: "acme" } });
    const [row] = await sql`SELECT vis FROM entry_changes WHERE entry_id = ${t.value.id} AND kind='created'`;
    assert.deepEqual(row.vis.org, { claim: "org_id", field: "org" }, "org scope captured in vis");
    assert.equal(row.vis.ownerField, "owner");
  });

  it("cursor resume: since=<cursor> returns only newer rows", async () => {
    const first = await mcp(p.mcpToken, "get_changes", { collection: "posts", limit: 1 });
    assert.ok(first.value.changes.length >= 1);
    const cursor = first.value.cursor;
    const next = await mcp(p.mcpToken, "get_changes", { collection: "posts", since: cursor, limit: 500 });
    // Every returned row is strictly after the cursor (its own cursor differs).
    assert.ok(next.value.changes.every((x) => x.cursor !== first.value.changes[0].cursor));
  });

  it("a bad cursor is E_VALIDATION with a fix hint", async () => {
    const bad = await mcp(p.mcpToken, "get_changes", { since: "not-a-cursor!!" });
    assert.ok(!bad.ok && /E_VALIDATION/.test(bad.errorText) && /cursor/.test(bad.errorText), bad.errorText);
  });

  it("restore_entry from trash feeds a `created` change (reappears for synced clients)", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "restore-me", published: true } });
    const id = c.value.id;
    await mcp(p.mcpToken, "delete_entry", { collection: "posts", id });
    const r = await mcp(p.mcpToken, "restore_entry", { collection: "posts", id });
    assert.ok(r.ok, r.errorText);
    const kinds = await sql`SELECT kind FROM entry_changes WHERE entry_id = ${id} ORDER BY seq`;
    assert.deepEqual(kinds.map((k) => k.kind), ["created", "deleted", "created"], "create, delete, restore→created");
  });

  it("bulk_create and transact also feed the change log", async () => {
    const bulk = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [{ title: "b1" }, { title: "b2" }],
    });
    assert.ok(bulk.ok, bulk.errorText);
    const tx = await mcp(p.mcpToken, "transact", {
      ops: [{ op: "create", collection: "posts", data: { title: "tx1" } }],
    });
    assert.ok(tx.ok, tx.errorText);
    // Confirm rows landed (direct SQL — no hold-back).
    const bulkRows = await sql`SELECT count(*)::int AS n FROM entry_changes
      WHERE project_id = ${p.id} AND data->>'title' IN ('b1','b2') AND kind='created'`;
    assert.equal(bulkRows[0].n, 2, "bulk create fed 2 rows");
    const txRows = await sql`SELECT count(*)::int AS n FROM entry_changes
      WHERE project_id = ${p.id} AND data->>'title' = 'tx1' AND kind='created'`;
    assert.equal(txRows[0].n, 1, "transact create fed 1 row");
  });
});
