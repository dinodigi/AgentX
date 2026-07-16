import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery, entryIndexNames } from "./helpers.mjs";

// Scale A2: an `indexed` field creates a matching DB expression index at
// define_collection time (via the same index-sync that does unique/search), so
// filter/sort by it is a seek. Also verifies the reject rules.
describe("scale: indexed fields (A2)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("scale-idx");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "products",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, publicRead: true },
        { name: "status", label: "Status", type: "enum", options: ["draft", "active", "archived"], indexed: true, publicRead: true },
        { name: "price", label: "Price", type: "number", indexed: true, publicRead: true },
      ],
    });
    assert.ok(def.ok, def.errorText);
    for (const [name, status, price] of [["A", "active", 10], ["B", "active", 30], ["C", "draft", 50]]) {
      const r = await mcp(p.mcpToken, "create_entry", { collection: "products", data: { name, status, price } });
      assert.ok(r.ok, r.errorText);
    }
  });
  after(() => p.destroy());

  it("indexed fields get matching DB expression indexes", async () => {
    const names = await entryIndexNames();
    assert.ok(names.some((n) => n.startsWith("entries_fx_") && n.endsWith("_status")), `status index missing: ${names}`);
    assert.ok(names.some((n) => n.startsWith("entries_fx_") && n.endsWith("_price")), "price index missing");
  });

  it("filter by an indexed enum (delivery eq) returns the right rows", async () => {
    const r = await delivery(p.deliveryToken, "/products?status=active");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 2, JSON.stringify(r.json.data));
  });

  it("range filter by an indexed number (MCP) returns the right rows", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "products",
      where: [{ field: "price", op: "gt", value: 20 }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 2); // B=30, C=50
  });

  it("dropping the index flag removes the DB index", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "products",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, publicRead: true },
        { name: "status", label: "Status", type: "enum", options: ["draft", "active", "archived"], publicRead: true }, // indexed removed
        { name: "price", label: "Price", type: "number", indexed: true, publicRead: true },
      ],
    });
    const names = await entryIndexNames();
    assert.ok(!names.some((n) => n.startsWith("entries_fx_") && n.endsWith("_status")), "status index should be dropped");
    assert.ok(names.some((n) => n.startsWith("entries_fx_") && n.endsWith("_price")), "price index should remain");
  });

  it("rejects indexed on richtext and group at define time", async () => {
    const badRt = await mcp(p.mcpToken, "define_collection", {
      name: "bad_rt",
      fields: [{ name: "body", label: "Body", type: "richtext", indexed: true }],
    });
    assert.equal(badRt.ok, false);
    const badGroup = await mcp(p.mcpToken, "define_collection", {
      name: "bad_grp",
      fields: [{ name: "g", label: "G", type: "group", indexed: true, fields: [{ name: "x", label: "X", type: "text" }] }],
    });
    assert.equal(badGroup.ok, false);
  });
});
