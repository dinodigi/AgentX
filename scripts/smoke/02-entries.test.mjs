import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

describe("entry CRUD + validation guards", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("entries");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "items",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "kind", label: "Kind", type: "enum", options: ["a", "b"], publicRead: true },
        { name: "qty", label: "Qty", type: "number" },
      ],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("create → get → update → delete round-trip", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "items", data: { title: "one", kind: "a" } });
    assert.ok(c.ok, c.errorText);
    const id = c.value.id;

    const g = await mcp(p.mcpToken, "get_entry", { collection: "items", id });
    assert.equal(g.value.data.title, "one");

    const u = await mcp(p.mcpToken, "update_entry", { collection: "items", id, data: { qty: 5 } });
    assert.equal(u.value.data.qty, 5);
    assert.equal(u.value.data.title, "one", "merge keeps other fields");

    const d = await mcp(p.mcpToken, "delete_entry", { collection: "items", id });
    assert.ok(d.ok);
    const gone = await mcp(p.mcpToken, "get_entry", { collection: "items", id });
    assert.ok(!gone.ok);
  });

  it("rejects unknown key, bad enum, wrong type, missing required", async () => {
    const cases = [
      [{ title: "x", evil: 1 }, /Unrecognized key/],
      [{ title: "x", kind: "z" }, /Invalid enum value/],
      [{ title: "x", qty: "many" }, /Expected number/],
      [{ kind: "a" }, /Required/],
    ];
    for (const [data, re] of cases) {
      const r = await mcp(p.mcpToken, "create_entry", { collection: "items", data });
      assert.ok(!r.ok && re.test(r.errorText), `${JSON.stringify(data)} → ${r.errorText}`);
    }
  });

  it("idempotency key returns the same entry on retry", async () => {
    const args = { collection: "items", data: { title: "idem" }, idempotencyKey: "smoke-idem-1" };
    const a = await mcp(p.mcpToken, "create_entry", args);
    const b = await mcp(p.mcpToken, "create_entry", args);
    assert.equal(a.value.id, b.value.id);
  });

  it("bulk create returns per-item results and inserts only valid items", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "items",
      entries: [{ title: "b1" }, { title: "b2", kind: "b" }, { title: "b3", kind: "nope" }],
    });
    assert.equal(r.value.created, 2);
    assert.equal(r.value.failed, 1);
    assert.ok(!r.value.results[2].ok);
  });

  it("count_entries with a filter", async () => {
    const r = await mcp(p.mcpToken, "count_entries", {
      collection: "items",
      where: [{ field: "kind", op: "eq", value: "b" }],
    });
    assert.equal(r.value.count, 1);
  });
});
