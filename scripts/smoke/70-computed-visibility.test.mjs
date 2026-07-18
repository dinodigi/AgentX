import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// F6 (v2 Track 0b): a PUBLIC computed field sourcing a private field would
// serve the private value verbatim on the anonymous delivery API. Rejected at
// define time — computed visibility may never exceed its sources'.
describe("computed-field visibility clamp (F6)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("computed-visibility");
  });

  it("rejects a public computed field sourcing a private field (template + slugify)", async () => {
    for (const computed of [
      { fn: "template", template: "{{secret}}" },
      { fn: "slugify", from: "secret" },
    ]) {
      const r = await mcp(p.mcpToken, "define_collection", {
        name: "reviews",
        fields: [
          { name: "secret", label: "S", type: "text", publicRead: false },
          { name: "leak", label: "L", type: "text", publicRead: true, computed },
        ],
      });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.errorText, /leak on the delivery API|publicRead/i, r.errorText);
    }
  });

  it("allows public-from-public and private-from-private; no leak end-to-end", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "slug", label: "Slug", type: "text", publicRead: true, computed: { fn: "slugify", from: "title" } },
        { name: "internal", label: "I", type: "text", publicRead: false },
        { name: "internal_slug", label: "IS", type: "text", computed: { fn: "slugify", from: "internal" } }, // private-from-private ok
      ],
    });
    assert.ok(def.ok, def.errorText);
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: { title: "Hello World", internal: "TOPSECRET-9000" },
    });
    assert.ok(c.ok, c.errorText);
    const r = await delivery(p.deliveryToken, "/posts");
    assert.equal(r.status, 200);
    const row = r.json.data[0];
    assert.equal(row.slug, "hello-world");
    assert.equal(row.internal, undefined);
    assert.equal(row.internal_slug, undefined, "private computed must not serve");
    assert.ok(!JSON.stringify(r.json).includes("TOPSECRET"), "no private value anywhere in the payload");
  });
});
