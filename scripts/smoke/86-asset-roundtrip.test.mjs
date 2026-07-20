import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// Wall report (Stallion 83e9dea9): MCP reads resolve asset values to
// {id,url,contentType} objects — including inside arrays since structured
// fields — but writes only accepted plain id strings, so the most natural
// editor flow (load → save back unchanged) failed E_VALIDATION. Writes now
// coerce a resolved object back to its id; relations get the same symmetry.
describe("read→write round-trip symmetry (assets + relations)", () => {
  let p, assetA, assetB, authorId;
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("roundtrip");
    for (const [name, holder] of [["a.png", "A"], ["b.png", "B"]]) {
      const r = await mcp(p.mcpToken, "upload_asset", { filename: name, contentType: "image/png", dataBase64: PNG });
      assert.ok(r.ok, r.errorText);
      if (holder === "A") assetA = r.value.id;
      else assetB = r.value.id;
    }
    const authors = await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [{ name: "name", label: "N", type: "text", required: true }],
    });
    assert.ok(authors.ok, authors.errorText);
    const a = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Ada" } });
    authorId = a.value.id;
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "galleries",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "cover", label: "Cover", type: "asset" },
        { name: "author", label: "A", type: "relation", targetCollection: "authors", labelField: "name" },
        { name: "images", label: "Images", type: "array", item: { type: "asset" }, maxItems: 20 },
      ],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("an untouched query_entries row saves back unchanged (the editor flow)", async () => {
    const created = await mcp(p.mcpToken, "create_entry", {
      collection: "galleries",
      data: { title: "Venue", cover: assetA, author: authorId, images: [assetA, assetB] },
    });
    assert.ok(created.ok, created.errorText);

    const q = await mcp(p.mcpToken, "query_entries", { collection: "galleries" });
    const row = q.value.entries.find((e) => e.id === created.value.id);
    assert.ok(row, "row present");
    // Reads resolve assets to objects — the premise of the report.
    assert.equal(typeof row.data.cover, "object", JSON.stringify(row.data.cover));
    assert.ok(row.data.cover.url, "resolved cover carries url");
    assert.equal(typeof row.data.images[0], "object", "array items resolved too");

    // The round-trip: write the read data back VERBATIM.
    const saved = await mcp(p.mcpToken, "update_entry", {
      collection: "galleries",
      id: created.value.id,
      data: row.data,
    });
    assert.ok(saved.ok, `verbatim save-back must succeed: ${saved.errorText}`);

    // Stored values are raw ids again (coerced), not objects.
    const got = await mcp(p.mcpToken, "get_entry", { collection: "galleries", id: created.value.id });
    const d = got.value.data;
    const coverId = typeof d.cover === "object" ? d.cover.id : d.cover;
    assert.equal(coverId, assetA, "cover survived the round-trip intact");
  });

  it("garbage objects still fail the uuid check (coercion is not a bypass)", async () => {
    const bad = await mcp(p.mcpToken, "create_entry", {
      collection: "galleries",
      data: { title: "X", cover: { id: "not-a-uuid" } },
    });
    assert.equal(bad.ok, false);
    assert.match(bad.errorText, /cover/i, bad.errorText);
    const noId = await mcp(p.mcpToken, "create_entry", {
      collection: "galleries",
      data: { title: "Y", cover: { url: "https://x/y.png" } },
    });
    assert.equal(noId.ok, false, "object without id must not pass");
  });
});
