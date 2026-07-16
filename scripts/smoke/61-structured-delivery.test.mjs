import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// Structured fields Layer 2: recursive delivery projection (F3) + recursive
// write-gate (F2) + nested asset resolution. The two security guarantees.
describe("structured fields: nested projection + write-gate", () => {
  let p, assetId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("structured-delivery");
    const up = await mcp(p.mcpToken, "upload_asset", {
      filename: "pic.png",
      contentType: "image/png",
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    });
    assert.ok(up.ok, up.errorText);
    assetId = up.value.id;

    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      publicWrite: true,
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        {
          name: "meta",
          label: "Meta",
          type: "group",
          publicRead: true,
          fields: [
            { name: "blurb", label: "Blurb", type: "text" }, // cascade → public
            { name: "internal_note", label: "Internal", type: "text", publicRead: false }, // private
            { name: "approved", label: "Approved", type: "boolean", publicRead: false, writableBy: "none" }, // locked flag
          ],
        },
        {
          name: "gallery",
          label: "Gallery",
          type: "array",
          publicRead: true,
          item: {
            type: "group",
            fields: [
              { name: "caption", label: "Caption", type: "text" },
              { name: "image", label: "Image", type: "asset" },
            ],
          },
        },
      ],
    });
    assert.ok(def.ok, def.errorText);

    // Trusted MCP write sets everything, including the private/locked sub-fields.
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: {
        title: "Hello",
        meta: { blurb: "public blurb", internal_note: "SECRET", approved: true },
        gallery: [{ caption: "shot 1", image: assetId }],
      },
    });
    assert.ok(c.ok, c.errorText);
  });
  after(() => p.destroy());

  it("F3: delivery strips private sub-fields; cascade keeps the rest; nested asset resolves", async () => {
    const r = await delivery(p.deliveryToken, "/posts");
    assert.equal(r.status, 200);
    const row = r.json.data[0];
    // cascade: blurb (no explicit publicRead) is served inside a public group
    assert.equal(row.meta.blurb, "public blurb");
    // opt-out: private sub-fields never leave the API
    assert.ok(!("internal_note" in row.meta), "internal_note must be stripped");
    assert.ok(!("approved" in row.meta), "the private flag must be stripped");
    assert.ok(!JSON.stringify(row).includes("SECRET"), "no private value anywhere");
    // nested asset resolved to {id,url,...}, not a raw uuid
    assert.equal(row.gallery[0].caption, "shot 1");
    assert.equal(row.gallery[0].image.id, assetId);
    assert.ok(typeof row.gallery[0].image.url === "string", "nested asset resolved to a url");
  });

  it("F2: an anonymous write to a nested writableBy:none flag is rejected", async () => {
    const bad = await delivery(p.deliveryToken, "/posts", {
      method: "POST",
      body: { title: "X", meta: { blurb: "ok", approved: true } },
    });
    assert.equal(bad.status, 403, JSON.stringify(bad.json));
    assert.ok(/approved/.test(bad.json.error), bad.json.error);
  });

  it("F2: an anonymous write to public nested content succeeds", async () => {
    const ok = await delivery(p.deliveryToken, "/posts", {
      method: "POST",
      body: { title: "X", meta: { blurb: "hello from a form" } },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
  });
});
