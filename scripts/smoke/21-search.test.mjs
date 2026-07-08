import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

describe("full-text search: search_entries (E1)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("search");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true, searchable: true },
        { name: "body", label: "Body", type: "richtext", publicRead: true, searchable: true },
        { name: "status", label: "Status", type: "enum", options: ["draft", "live"], publicRead: true },
      ],
    });
    assert.ok(def.ok, def.errorText);
    await mcp(p.mcpToken, "create_entry", { collection: "articles", data: { title: "Postgres full text search", body: "<p>tsvector and tsquery are powerful</p>", status: "live" } });
    await mcp(p.mcpToken, "create_entry", { collection: "articles", data: { title: "Cooking with fire", body: "<p>grill everything</p>", status: "live" } });
    await mcp(p.mcpToken, "create_entry", { collection: "articles", data: { title: "Search draft", body: "postgres notes", status: "draft" } });
  });
  after(() => p.destroy());

  it("matches across searchable fields and ranks results", async () => {
    const r = await mcp(p.mcpToken, "search_entries", { collection: "articles", q: "postgres" });
    assert.ok(r.ok, r.errorText);
    // "Postgres full text search" (title match) + "Search draft" (body: postgres notes)
    assert.equal(r.value.entries.length, 2);
    assert.ok(r.value.entries.every((e) => typeof e.rank === "number"));
    // ranked desc — highest rank first
    assert.ok(r.value.entries[0].rank >= r.value.entries[1].rank);
  });

  it("richtext HTML tags are stripped (search matches text, not markup)", async () => {
    const r = await mcp(p.mcpToken, "search_entries", { collection: "articles", q: "tsvector" });
    assert.equal(r.value.entries.length, 1);
    assert.equal(r.value.entries[0].data.title, "Postgres full text search");
    // a query for the tag name must NOT match
    const tagQ = await mcp(p.mcpToken, "search_entries", { collection: "articles", q: "\"p\"" });
    assert.equal(tagQ.value.entries.length, 0);
  });

  it("websearch phrase query works", async () => {
    const r = await mcp(p.mcpToken, "search_entries", { collection: "articles", q: '"full text"' });
    assert.equal(r.value.entries.length, 1);
    assert.equal(r.value.entries[0].data.title, "Postgres full text search");
  });

  it("where filters narrow the search", async () => {
    const r = await mcp(p.mcpToken, "search_entries", {
      collection: "articles",
      q: "postgres",
      where: [{ field: "status", op: "eq", value: "live" }],
    });
    assert.equal(r.value.entries.length, 1); // the draft is excluded
    assert.equal(r.value.entries[0].data.status, "live");
  });

  it("a collection with no searchable fields errors with a fix hint", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "plain",
      fields: [{ name: "name", label: "N", type: "text", required: true }],
    });
    const r = await mcp(p.mcpToken, "search_entries", { collection: "plain", q: "x" });
    assert.ok(!r.ok && /\[E_VALIDATION\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /no searchable fields/);
  });

  it("searchable on a non-text field is rejected at define time", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      fields: [{ name: "n", label: "N", type: "number", searchable: true }],
    });
    assert.ok(!r.ok && /searchable is only valid on text\/richtext/.test(r.errorText), r.errorText);
  });
});

import { delivery } from "./helpers.mjs";
import { neon } from "@neondatabase/serverless";
const rawSql = neon(process.env.DATABASE_URL);

describe("full-text search: delivery ?q= + GIN index (E2/E3)", () => {
  let p, collId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("search-delivery");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true, searchable: true },
        { name: "notes", label: "Notes", type: "text", searchable: true }, // searchable but PRIVATE
        { name: "published", label: "Published", type: "boolean", publicRead: true },
      ],
      publicFilter: [{ field: "published", op: "eq", value: true }],
    });
    const [c] = await rawSql`SELECT id FROM collections WHERE project_id = ${p.id} AND name = 'posts'`;
    collId = c.id;
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Postgres tips", notes: "internal draft note", published: true } });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Hidden post about postgres", notes: "x", published: false } });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Cooking", notes: "secretword lives here only", published: true } });
  });
  after(() => p.destroy());

  it("delivery ?q= searches public searchable fields, rank-ordered, respecting publicFilter", async () => {
    const r = await delivery(p.deliveryToken, "/posts?q=postgres");
    assert.equal(r.status, 200);
    // "Postgres tips" is public+published; "Hidden post about postgres" is unpublished → excluded
    assert.equal(r.json.data.length, 1);
    assert.equal(r.json.data[0].title, "Postgres tips");
  });

  it("a match found ONLY in a private searchable field does NOT surface via ?q", async () => {
    // "secretword" lives only in the private `notes` field.
    const r = await delivery(p.deliveryToken, "/posts?q=secretword");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 0, "private searchable field must not be reachable via delivery ?q");
  });

  it("?q= with ?sort is a 422", async () => {
    const r = await delivery(p.deliveryToken, "/posts?q=x&sort=title:asc");
    assert.equal(r.status, 422);
    assert.match(r.json.error, /rank-ordered/);
  });

  it("?q= on a collection with no public searchable fields is 422", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "priv",
      fields: [
        { name: "name", label: "N", type: "text", required: true, publicRead: true }, // public but NOT searchable
        { name: "s", label: "S", type: "text", searchable: true }, // searchable but not public
      ],
    });
    const r = await delivery(p.deliveryToken, "/priv?q=x");
    assert.equal(r.status, 422);
    assert.match(r.json.error, /no public searchable fields/);
  });

  it("E3: the GIN index over the public subset exists and the delivery query uses it", async () => {
    const idx = await rawSql`SELECT indexname FROM pg_indexes WHERE tablename='entries' AND indexname LIKE 'entries_fts_%' AND indexdef LIKE '%' || ${collId} || '%'`;
    assert.ok(idx.length >= 1, "a GIN fts index should exist for the collection");
  });

  it("E3: toggling publicRead off rebuilds/clears the index; delete drops it", async () => {
    const before = await rawSql`SELECT indexname FROM pg_indexes WHERE tablename='entries' AND indexdef LIKE '%' || ${collId} || '%' AND indexname LIKE 'entries_fts_%'`;
    assert.ok(before.length >= 1);
    // make the only public searchable field private → public subset empties → index dropped
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, searchable: true }, // publicRead removed
        { name: "notes", label: "Notes", type: "text", searchable: true },
        { name: "published", label: "Published", type: "boolean", publicRead: true },
      ],
      publicFilter: [{ field: "published", op: "eq", value: true }],
      confirm: true,
    });
    const after = await rawSql`SELECT indexname FROM pg_indexes WHERE tablename='entries' AND indexdef LIKE '%' || ${collId} || '%' AND indexname LIKE 'entries_fts_%'`;
    assert.equal(after.length, 0, "no public searchable fields → fts index dropped");
  });
});
