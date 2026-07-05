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

  it("in: value lists on enum and text", async () => {
    const byLevel = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "level", op: "in", value: ["easy", "hard"] }],
    });
    assert.equal(byLevel.value.entries.length, 3);

    const byTitle = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "title", op: "in", value: ["Alpha paddle", "Gamma glide"] }],
    });
    assert.deepEqual(
      byTitle.value.entries.map((r) => r.data.title).sort(),
      ["Alpha paddle", "Gamma glide"],
    );

    const count = await mcp(p.mcpToken, "count_entries", {
      collection: "trips",
      where: [{ field: "level", op: "in", value: ["hard"] }],
    });
    assert.equal(count.value.count, 1);
  });

  it("in: rejected on numbers, empty lists, and scalar-op arrays", async () => {
    const onNumber = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "price", op: "in", value: ["50"] }],
    });
    assert.ok(!onNumber.ok && /allowed: eq/.test(onNumber.errorText), onNumber.errorText);

    const empty = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "level", op: "in", value: [] }],
    });
    assert.ok(!empty.ok && /non-empty array/.test(empty.errorText), empty.errorText);

    const arrayOnEq = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ field: "level", op: "eq", value: ["easy"] }],
    });
    assert.ok(!arrayOnEq.ok && /use op "in"/.test(arrayOnEq.errorText), arrayOnEq.errorText);
  });

  it("anyOf: OR groups AND with sibling items, one level only", async () => {
    // (title contains "paddle" OR price > 100) AND level = easy
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [
        {
          anyOf: [
            { field: "title", op: "contains", value: "paddle" },
            { field: "price", op: "gt", value: 100 },
          ],
        },
        { field: "level", op: "eq", value: "easy" },
      ],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.entries.map((e) => e.data.title), ["Alpha paddle"]);

    const orOnly = await mcp(p.mcpToken, "count_entries", {
      collection: "trips",
      where: [
        {
          anyOf: [
            { field: "title", op: "contains", value: "paddle" },
            { field: "price", op: "gt", value: 100 },
          ],
        },
      ],
    });
    assert.equal(orOnly.value.count, 2); // Alpha paddle + Beta rapids

    // Bad clauses inside a group still get the full validation treatment.
    const badInner = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ anyOf: [{ field: "nope", op: "eq", value: 1 }] }],
    });
    assert.ok(!badInner.ok && /valid fields:/.test(badInner.errorText), badInner.errorText);

    const empty = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      where: [{ anyOf: [] }],
    });
    assert.ok(!empty.ok, "empty anyOf must be rejected");
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

  it("select trims MCP results to the named fields, id kept", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      select: ["title"],
      orderBy: { field: "price", dir: "asc" },
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries[0].data.title, "Alpha paddle");
    assert.deepEqual(Object.keys(r.value.entries[0].data), ["title"]);
    assert.ok(r.value.entries[0].id, "id must survive selection");

    const bad = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      select: ["title", "nope"],
    });
    assert.ok(!bad.ok && /valid fields:/.test(bad.errorText), bad.errorText);
  });

  it("cursor: keyset pages walk every row exactly once", async () => {
    const seen = [];
    let cursor;
    let guard = 0;
    for (;;) {
      const r = await mcp(p.mcpToken, "query_entries", {
        collection: "trips",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(r.ok, r.errorText);
      seen.push(...r.value.entries.map((e) => e.data.title));
      if (!r.value.hasMore) {
        assert.equal(r.value.nextCursor, null);
        break;
      }
      assert.ok(typeof r.value.nextCursor === "string" && r.value.nextCursor.length > 0);
      cursor = r.value.nextCursor;
      assert.ok(++guard < 10, "cursor loop never terminated");
    }
    assert.deepEqual(seen.sort(), ["Alpha paddle", "Beta rapids", "Gamma glide"]);
  });

  it("cursor: mode guards and garbage cursors get fix hints", async () => {
    const both = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      cursor: "abc",
      offset: 2,
    });
    assert.ok(!both.ok && /not both/.test(both.errorText), both.errorText);

    const first = await mcp(p.mcpToken, "query_entries", { collection: "trips", limit: 1 });
    const withOrder = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      cursor: first.value.nextCursor,
      orderBy: { field: "price", dir: "asc" },
    });
    assert.ok(!withOrder.ok && /default .*ordering/.test(withOrder.errorText), withOrder.errorText);

    const garbage = await mcp(p.mcpToken, "query_entries", {
      collection: "trips",
      cursor: "not-a-cursor",
    });
    assert.ok(!garbage.ok && /invalid cursor/.test(garbage.errorText), garbage.errorText);
  });

  it("delivery ?select= trims public rows; private select is 422", async () => {
    const r = await delivery(p.deliveryToken, "/trips?select=title&sort=price:asc");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.data[0]).sort(), ["id", "title"]);

    const priv = await delivery(p.deliveryToken, "/trips?select=notes");
    assert.equal(priv.status, 422);
    assert.ok(/non-public/.test(priv.json.error));
  });

  it("delivery filters are restricted to public fields (422 on private)", async () => {
    const r = await delivery(p.deliveryToken, "/trips?notes=secret");
    assert.equal(r.status, 422);
    assert.ok(/non-public/.test(r.json.error));
  });
});
