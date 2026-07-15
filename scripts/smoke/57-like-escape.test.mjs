import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// F4 (HAv1): `contains` must treat `%` and `_` as literals, not LIKE wildcards
// (the report's example: contains "_isbo" wrongly matched "Lisbon").
describe("F4: contains escapes LIKE wildcards", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("f4-like");
    await mcp(p.mcpToken, "define_collection", {
      name: "cities",
      fields: [{ name: "name", label: "Name", type: "text", searchable: true }],
    });
    for (const name of ["Lisbon", "l_isbo literal", "50% off", "50 cents"]) {
      await mcp(p.mcpToken, "create_entry", { collection: "cities", data: { name } });
    }
  });
  after(() => p.destroy());

  const names = (res) => res.value.entries.map((e) => e.data.name).sort();

  it("underscore matches a literal underscore, not any-char", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "cities",
      where: [{ field: "name", op: "contains", value: "_isbo" }],
    });
    assert.ok(r.ok, r.errorText);
    // Must NOT match "Lisbon" (where _ would be a wildcard); must match the literal.
    assert.deepEqual(names(r), ["l_isbo literal"]);
  });

  it("percent matches a literal percent, not any-run", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "cities",
      where: [{ field: "name", op: "contains", value: "50%" }],
    });
    assert.ok(r.ok, r.errorText);
    // Must match only "50% off", not "50 cents" (where % would be a wildcard).
    assert.deepEqual(names(r), ["50% off"]);
  });

  it("a plain substring still matches normally", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "cities",
      where: [{ field: "name", op: "contains", value: "isbo" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(names(r), ["Lisbon", "l_isbo literal"]);
  });
});
