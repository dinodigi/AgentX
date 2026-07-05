import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

describe("query filters + sorting", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("query");
    await mcp(p.mcpToken, "define_collection", {
      name: "trips",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "price", label: "Price", type: "number", publicRead: true },
        { name: "level", label: "Level", type: "enum", options: ["easy", "hard"], publicRead: true },
        { name: "notes", label: "Notes", type: "text" },
      ],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "trips",
      entries: [
        { title: "Alpha paddle", price: 50, level: "easy", notes: "secret" },
        { title: "Beta rapids", price: 150, level: "hard" },
        { title: "Gamma glide", price: 90, level: "easy" },
      ],
    });
  });
  after(() => p.destroy());

  it("eq, contains, gt, lt", async () => {
    const eq = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "level", op: "eq", value: "easy" }],
    });
    assert.equal(eq.value.entries.length, 2);

    const contains = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "title", op: "contains", value: "rapids" }],
    });
    assert.equal(contains.value.entries.length, 1);

    const gt = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "price", op: "gt", value: 80 }],
    });
    assert.equal(gt.value.entries.length, 2);

    const lt = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "price", op: "lt", value: 60 }],
    });
    assert.equal(lt.value.entries.length, 1);
  });

  it("rejects op/type mismatch with an allowed-ops hint", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "level", op: "contains", value: "ea" }],
    });
    assert.ok(!r.ok && /allowed: eq/.test(r.errorText));
  });

  it("rejects unknown filter field with a field list", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "nope", op: "eq", value: 1 }],
    });
    assert.ok(!r.ok && /valid fields:/.test(r.errorText));
  });

  it("orderBy sorts numerically, both directions", async () => {
    const asc = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      orderBy: { field: "price", dir: "asc" },
    });
    assert.deepEqual(
      asc.value.entries.map((r) => r.data.price),
      [50, 90, 150],
    );
    const desc = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      orderBy: { field: "price", dir: "desc" },
    });
    assert.equal(desc.value.entries[0].data.price, 150);
  });

  it("delivery filters are restricted to public fields (422 on private)", async () => {
    const r = await delivery(p.deliveryToken, "/trips?notes=secret");
    assert.equal(r.status, 422);
    assert.ok(/non-public/.test(r.json.error));
  });
});
