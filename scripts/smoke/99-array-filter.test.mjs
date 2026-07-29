import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// Burn-down CP7 / field-signal C1 — array fields are filterable on the delivery
// API. This had the worst failure profile on the board: a tag archive fetched
// every row and filtered in memory, so it shipped fine at 5 posts and was
// wrong at 500 — AFTER a customer had invested. The generated client's filter
// type advertised `tags` the whole time, which is what made it look supported.

describe("C1 — array membership filtering", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("array-filter");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "tags", label: "Tags", type: "array", item: { type: "text" }, publicRead: true },
        { name: "scores", label: "Scores", type: "array", item: { type: "number" }, publicRead: true },
        {
          name: "sections",
          label: "Sections",
          type: "array",
          item: { type: "group", fields: [{ name: "heading", label: "H", type: "text" }] },
        },
      ],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [
        { title: "rust post", tags: ["rust", "systems"], scores: [1, 2] },
        { title: "go post", tags: ["go", "systems"], scores: [2, 3] },
        { title: "untagged", scores: [] },
      ],
    });
  });
  after(() => p.destroy());

  it("THE POINT: MCP filters by membership instead of scanning", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "tags", op: "has", value: "systems" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.entries.map((e) => e.data.title).sort(), ["go post", "rust post"]);
  });

  it("matches one tag exactly, not a substring of another", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "tags", op: "has", value: "rus" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 0, "containment is exact — 'rus' must not match 'rust'");
  });

  it("number items coerce, so a numeric tag does not silently miss", async () => {
    // JSON 1 !== "1"; without coercion this returns nothing and looks like
    // "no results" rather than a type mismatch.
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "scores", op: "has", value: 2 }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 2);
  });

  it("THE POINT: the DELIVERY API filters too — ?tags=rust", async () => {
    const res = await delivery(p.deliveryToken, "/posts?tags=rust");
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json.data.map((d) => d.title), ["rust post"]);
  });

  it("...and a non-matching value returns none, not everything", async () => {
    // The in-memory workaround's failure mode was returning the whole set.
    const res = await delivery(p.deliveryToken, "/posts?tags=haskell");
    assert.equal(res.status, 200);
    assert.equal(res.json.data.length, 0);
  });

  it("an array of GROUPS is still refused — structured content is not a set", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "sections", op: "has", value: "x" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not valid for/);
  });

  it("sorting by an array is refused rather than silently ordering by JSONB", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      orderBy: { field: "tags", dir: "asc" },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /cannot be sorted/);
  });

  it("the generated client types the filter as the ITEM, and omits arrays from sort", async () => {
    const r = await mcp(p.mcpToken, "get_client_code", {});
    assert.ok(r.ok, r.errorText);
    const code = r.value.code;
    // `?tags=rust` asks "does this set contain rust" — so the filter takes a
    // single value. Typing it as string[] would generate code that cannot
    // express the query the API actually supports.
    // Scope to the ListOpts FILTER block: `tags?: unknown[]` is correct in the
    // Create shape (you write an array), so asserting over the whole file would
    // be testing the wrong thing.
    const optsStart = code.indexOf("export interface PostsListOpts");
    const filterBlock = code.slice(optsStart, code.indexOf("}", code.indexOf("filter?: {", optsStart)));
    assert.match(filterBlock, /tags\?: string;/, "filter value is the item type, not the array");
    assert.doesNotMatch(filterBlock, /tags\?: unknown\[\];/);
    const sortLine = code.split("\n").find((l) => l.includes("sort?: { field:"));
    assert.ok(sortLine, "a sort union must still be generated");
    assert.doesNotMatch(sortLine, /"tags"/, "an unsortable field must not appear in the sort union");
  });
});
