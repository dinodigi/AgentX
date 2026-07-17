import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// Track 1 (Post-Deployment v1.0): typed blocks — array:{blocks:[...]} is a
// discriminated union on the stored `_type`. A page body is a sequence of
// DIFFERENT sections; validation/projection/write-gate/assets all dispatch on
// the element's own block type, and the F2/F3 guarantees hold PER BLOCK.
describe("block types (heterogeneous page bodies)", () => {
  let p, assetId, entryId;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("block-types");

    const up = await mcp(p.mcpToken, "upload_asset", {
      filename: "hero.png",
      contentType: "image/png",
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    });
    assert.ok(up.ok, up.errorText);
    assetId = up.value.id;

    const def = await mcp(p.mcpToken, "define_collection", {
      name: "pages",
      publicWrite: true,
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        {
          name: "body",
          label: "Body",
          type: "array",
          publicRead: true,
          blocks: [
            {
              name: "hero",
              label: "Hero",
              fields: [
                { name: "heading", label: "Heading", type: "text", required: true },
                { name: "image", label: "Image", type: "asset" },
                { name: "internal_note", label: "Note", type: "text", publicRead: false }, // F3 per block
              ],
            },
            {
              name: "features",
              label: "Features",
              fields: [
                { name: "items", label: "Items", type: "array", item: { type: "text" } }, // scalar sub-array ok
              ],
            },
            {
              name: "quote",
              label: "Quote",
              fields: [
                { name: "text", label: "Text", type: "text", required: true },
                { name: "approved", label: "Approved", type: "boolean", writableBy: "none" }, // F2 per block
              ],
            },
          ],
        },
      ],
    });
    assert.ok(def.ok, def.errorText);

    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: {
        title: "Home",
        body: [
          { _type: "hero", heading: "Welcome", image: assetId, internal_note: "SECRET" },
          { _type: "features", items: ["fast", "typed", "safe"] },
          { _type: "quote", text: "It works.", approved: true }, // trusted MCP write
        ],
      },
    });
    assert.ok(c.ok, c.errorText);
    entryId = c.value.id;
  });

  it("delivery keeps _type, strips per-block private fields (F3), resolves nested assets", async () => {
    const r = await delivery(p.deliveryToken, `/pages/${entryId}`);
    assert.equal(r.status, 200);
    const body = r.json.data.body;
    assert.equal(body.length, 3);
    assert.deepEqual(
      body.map((b) => b._type),
      ["hero", "features", "quote"],
    );
    assert.equal(body[0].heading, "Welcome");
    assert.equal(body[0].internal_note, undefined, "private block field must be stripped");
    assert.equal(typeof body[0].image, "object");
    assert.ok(body[0].image.url, "nested asset must resolve to {id,url,contentType}");
    assert.deepEqual(body[1].items, ["fast", "typed", "safe"]);
    assert.equal(body[2].approved, true, "cascade: no publicRead:false ⇒ public inside a public container");
  });

  it("an unknown _type is rejected at write time (discriminated union)", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { title: "X", body: [{ _type: "banner", heading: "?" }] },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /_type|discriminator|invalid/i, r.errorText);
  });

  it("a block's writableBy:none field blocks anonymous delivery writes (F2)", async () => {
    const r = await delivery(p.deliveryToken, "/pages", {
      method: "POST",
      body: { title: "Anon", body: [{ _type: "quote", text: "hi", approved: true }] },
    });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.match(r.json.error, /not writable/i);
  });

  it("anonymous write of allowed block content succeeds", async () => {
    const r = await delivery(p.deliveryToken, "/pages", {
      method: "POST",
      body: { title: "Anon ok", body: [{ _type: "quote", text: "hello" }] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  });

  it("define-time: exactly one of item|blocks", async () => {
    const both = await mcp(p.mcpToken, "define_collection", {
      name: "bad_both",
      fields: [
        {
          name: "a",
          label: "A",
          type: "array",
          item: { type: "text" },
          blocks: [{ name: "x", label: "X", fields: [{ name: "t", label: "T", type: "text" }] }],
        },
      ],
    });
    assert.equal(both.ok, false);
    assert.match(both.errorText, /exactly one of item/i);
    const neither = await mcp(p.mcpToken, "define_collection", {
      name: "bad_neither",
      fields: [{ name: "a", label: "A", type: "array" }],
    });
    assert.equal(neither.ok, false);
    assert.match(neither.errorText, /exactly one of item/i);
  });

  it("define-time: _type is reserved inside a block", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad_reserved",
      fields: [
        {
          name: "a",
          label: "A",
          type: "array",
          blocks: [{ name: "x", label: "X", fields: [{ name: "_type", label: "T", type: "text" }] }],
        },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /reserved/i);
  });

  it("define-time: no repeater-of-groups (or blocks) inside a block — one level", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad_deep",
      fields: [
        {
          name: "a",
          label: "A",
          type: "array",
          blocks: [
            {
              name: "x",
              label: "X",
              fields: [
                {
                  name: "inner",
                  label: "Inner",
                  type: "array",
                  item: { type: "group", fields: [{ name: "t", label: "T", type: "text" }] },
                },
              ],
            },
          ],
        },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /too deep|related collection/i);
  });

  it("define-time: duplicate block names rejected", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad_dupe",
      fields: [
        {
          name: "a",
          label: "A",
          type: "array",
          blocks: [
            { name: "x", label: "X1", fields: [{ name: "t", label: "T", type: "text" }] },
            { name: "x", label: "X2", fields: [{ name: "u", label: "U", type: "text" }] },
          ],
        },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /duplicate block name/i);
  });

  it("uniform repeaters (item) still work unchanged", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "hours",
      fields: [
        {
          name: "slots",
          label: "Slots",
          type: "array",
          publicRead: true,
          item: { type: "group", fields: [{ name: "day", label: "Day", type: "text" }] },
        },
      ],
    });
    assert.ok(def.ok, def.errorText);
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "hours",
      data: { slots: [{ day: "Mon" }, { day: "Tue" }] },
    });
    assert.ok(c.ok, c.errorText);
  });
});
