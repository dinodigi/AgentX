import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// v2 Track 3a: POST /v1/batch — several reads in one round trip, built as a
// multiplexer over the REAL list handler, so gating is identical by
// construction. Per-item statuses; the envelope is 200.
describe("batch delivery reads", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("batch-read");
    for (const [name, publicRead] of [["posts", true], ["nav", true], ["secrets", false]]) {
      const def = await mcp(p.mcpToken, "define_collection", {
        name,
        fields: [{ name: "title", label: "T", type: "text", required: true, publicRead }],
      });
      assert.ok(def.ok, def.errorText);
      const c = await mcp(p.mcpToken, "create_entry", { collection: name, data: { title: `${name}-1` } });
      assert.ok(c.ok, c.errorText);
    }
  });

  it("answers several collections in one call, per-item gating intact", async () => {
    const r = await delivery(p.deliveryToken, "/batch", {
      method: "POST",
      body: {
        queries: [
          { collection: "posts", params: { limit: 5 } },
          { collection: "nav" },
          { collection: "secrets" }, // zero public fields → the list handler's 404
          { collection: "missing" },
        ],
      },
    });
    assert.equal(r.status, 200);
    const [posts, nav, secrets, missing] = r.json.results;
    assert.equal(posts.status, 200);
    assert.equal(posts.data[0].title, "posts-1");
    assert.equal(nav.status, 200);
    assert.equal(nav.data[0].title, "nav-1");
    assert.equal(secrets.status, 404, "no-public-fields collection must 404 exactly like a direct GET");
    assert.equal(missing.status, 404);
  });

  it("sub-query filters flow through the real handler (validation included)", async () => {
    const r = await delivery(p.deliveryToken, "/batch", {
      method: "POST",
      body: {
        queries: [
          { collection: "posts", params: { title: "posts-1" } },
          { collection: "posts", params: { nope: "x" } }, // unknown filter → 422 per item
        ],
      },
    });
    const [hit, bad] = r.json.results;
    assert.equal(hit.status, 200);
    assert.equal(hit.data.length, 1);
    assert.equal(bad.status, 422);
    assert.match(bad.error, /unknown or non-public filter/i);
  });

  it("bounds: >10 queries rejected; bad shapes rejected; auth required", async () => {
    const over = await delivery(p.deliveryToken, "/batch", {
      method: "POST",
      body: { queries: Array.from({ length: 11 }, () => ({ collection: "posts" })) },
    });
    assert.equal(over.status, 422);
    const shape = await delivery(p.deliveryToken, "/batch", { method: "POST", body: {} });
    assert.equal(shape.status, 422);
    const noAuth = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: [{ collection: "posts" }] }),
    });
    assert.equal(noAuth.status, 401);
  });

  it('"batch" is a reserved collection name now', async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "batch",
      fields: [{ name: "t", label: "T", type: "text" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /reserved/i);
  });
});
