import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// Structured fields Layer 1: group + array (repeaters) — recursive definition +
// value validation + the D4-style structural caps (depth, maxItems, nesting).
// (Delivery projection + write-gate recursion land in Layer 2; tested via MCP here.)
describe("structured fields: group + array definition + validation", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("structured");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "pages",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        {
          name: "seo",
          label: "SEO",
          type: "group",
          publicRead: true,
          fields: [
            { name: "meta_title", label: "Meta title", type: "text", publicRead: true },
            { name: "meta_description", label: "Meta description", type: "text", publicRead: true },
          ],
        },
        {
          name: "sections",
          label: "Sections",
          type: "array",
          publicRead: true,
          maxItems: 10,
          item: {
            type: "group",
            fields: [
              { name: "heading", label: "Heading", type: "text" },
              { name: "body", label: "Body", type: "richtext" },
            ],
          },
        },
      ],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("accepts a valid nested entry and reads it back", async () => {
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: {
        title: "Home",
        seo: { meta_title: "Home", meta_description: "Welcome" },
        sections: [
          { heading: "Hero", body: "<p>hi</p>" },
          { heading: "Features", body: "<p>stuff</p>" },
        ],
      },
    });
    assert.ok(c.ok, c.errorText);
    const q = await mcp(p.mcpToken, "query_entries", { collection: "pages" });
    const row = q.value.entries.find((e) => e.id === c.value.id);
    assert.equal(row.data.seo.meta_title, "Home");
    assert.equal(row.data.sections.length, 2);
    assert.equal(row.data.sections[1].heading, "Features");
  });

  it("rejects a wrong-typed nested value", async () => {
    const bad = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { title: "X", sections: [{ heading: 123 }] }, // heading must be a string
    });
    assert.equal(bad.ok, false, "a number heading must be rejected");
  });

  it("rejects an unknown sub-key (strict groups)", async () => {
    const bad = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { title: "X", seo: { metaTitle: "ok", bogus: "nope" } },
    });
    assert.equal(bad.ok, false, "unknown group sub-key must be rejected");
  });

  it("rejects an over-cap array (maxItems)", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ heading: `h${i}` }));
    const bad = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { title: "X", sections: many },
    });
    assert.equal(bad.ok, false, "11 items over a maxItems:10 array must be rejected");
  });

  it("rejects a repeater-in-repeater (one level of repeating only)", async () => {
    const bad = await mcp(p.mcpToken, "define_collection", {
      name: "pricing",
      fields: [
        {
          name: "plans",
          label: "Plans",
          type: "array",
          item: {
            type: "group",
            fields: [
              { name: "name", label: "Name", type: "text" },
              {
                name: "tiers", // a repeater inside a repeater — model as a relation instead
                label: "Tiers",
                type: "array",
                item: { type: "group", fields: [{ name: "label", label: "Label", type: "text" }] },
              },
            ],
          },
        },
      ],
    });
    assert.equal(bad.ok, false, "a second level of repeating must be rejected");
  });

  it("still allows a scalar sub-array (tags) inside a repeater item", async () => {
    const ok = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        {
          name: "sections",
          label: "Sections",
          type: "array",
          item: {
            type: "group",
            fields: [
              { name: "heading", label: "Heading", type: "text" },
              { name: "tags", label: "Tags", type: "array", item: { type: "text" } },
            ],
          },
        },
      ],
    });
    assert.ok(ok.ok, ok.errorText);
  });

  it("rejects a third level of repeater nesting at define time", async () => {
    const bad = await mcp(p.mcpToken, "define_collection", {
      name: "toodeep",
      fields: [
        {
          name: "a1",
          label: "A1",
          type: "array",
          item: {
            type: "group",
            fields: [
              {
                name: "a2",
                label: "A2",
                type: "array",
                item: {
                  type: "group",
                  fields: [
                    {
                      name: "a3",
                      label: "A3",
                      type: "array",
                      item: { type: "group", fields: [{ name: "x", label: "X", type: "text" }] },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    assert.equal(bad.ok, false, "repeater nesting past depth 2 must be rejected");
  });

  it("ACCEPTS a relation nested inside a group (v1.1 relations-in-blocks)", async () => {
    // Contract flipped 2026-07-17 (v2 Track 1a): nested relation is the
    // prescribed pattern for repeating cards — full coverage in 71-nested-relations.
    const ok = await mcp(p.mcpToken, "define_collection", {
      name: "goodrel",
      fields: [
        {
          name: "g",
          label: "G",
          type: "group",
          fields: [
            { name: "r", label: "R", type: "relation", targetCollection: "pages", labelField: "title" },
          ],
        },
      ],
    });
    assert.ok(ok.ok, ok.errorText);
  });
});
