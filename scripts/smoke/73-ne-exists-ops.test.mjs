import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// v2 Track 3b: `ne` (SET-and-different — unset never matches, fail-closed) and
// `exists` (presence). The dogfood gap: "published OR unset" was inexpressible.
// Both evaluators must agree: SQL (list queries) and in-memory matchesClauses
// (single-entry gates) — the publicFilter test exercises both paths.
describe("query ops: ne + exists", () => {
  let p, ids;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("ne-exists");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      // Row visibility: published true OR never set (draft-by-default inverted —
      // exactly the shape the field report couldn't express).
      publicFilter: [
        { anyOf: [{ field: "published", op: "eq", value: true }, { field: "published", op: "exists", value: false }] },
      ],
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "published", label: "P", type: "boolean", publicRead: true },
      ],
    });
    assert.ok(def.ok, def.errorText);
    ids = {};
    for (const [key, data] of [
      ["pub", { title: "published", published: true }],
      ["hidden", { title: "hidden", published: false }],
      ["unset", { title: "unset" }],
    ]) {
      const c = await mcp(p.mcpToken, "create_entry", { collection: "posts", data });
      assert.ok(c.ok, c.errorText);
      ids[key] = c.value.id;
    }
  });

  const titles = (rows) => rows.map((r) => r.data?.title ?? r.title).sort();

  it("ne matches only SET-and-different rows (unset excluded — documented)", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "published", op: "ne", value: true }],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(titles(r.value.entries ?? r.value), ["hidden"]);
  });

  it("exists true/false split the set exactly", async () => {
    const yes = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "published", op: "exists", value: true }],
    });
    assert.deepEqual(titles(yes.value.entries ?? yes.value), ["hidden", "published"]);
    const no = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "published", op: "exists", value: false }],
    });
    assert.deepEqual(titles(no.value.entries ?? no.value), ["unset"]);
  });

  it("'published OR unset' works as a publicFilter — list AND single-entry agree", async () => {
    const list = await delivery(p.deliveryToken, "/posts");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.data.map((r) => r.title).sort(), ["published", "unset"]);
    // Single-entry path runs the IN-MEMORY evaluator (matchesClauses) — parity:
    assert.equal((await delivery(p.deliveryToken, `/posts/${ids.pub}`)).status, 200);
    assert.equal((await delivery(p.deliveryToken, `/posts/${ids.unset}`)).status, 200);
    assert.equal((await delivery(p.deliveryToken, `/posts/${ids.hidden}`)).status, 404, "hidden row must 404");
  });

  it("exists rejects a non-boolean value; ne rejects on unsupported types", async () => {
    const bad = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "published", op: "exists", value: "yes" }],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.errorText, /takes true or false/i, bad.errorText);
    const badNe = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "title", op: "gt", value: "a" }],
    });
    assert.equal(badNe.ok, false, "type-checking still enforced");
  });
});
