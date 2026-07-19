import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// CDN edge-cache contract (docs/runbooks/CDN-SETUP.md): PUBLIC delivery reads emit
// s-maxage (+ Vary: authorization — same URL serves different tenants per
// token) so a per-tenant-keyed shared cache may serve them; everything else
// stays no-cache/uncached. Raw fetch — the delivery() helper hides headers.
describe("delivery cache headers (edge contract)", () => {
  let p, entryId;

  const get = (path, headers = {}) =>
    fetch(`${BASE}/api/v1${path}`, {
      headers: { authorization: `Bearer ${p.deliveryToken}`, ...headers },
    });

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("cache-headers");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "Title", type: "text", required: true, publicRead: true }],
    });
    assert.ok(def.ok, def.errorText);
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: { title: "Hello" },
    });
    assert.ok(c.ok, c.errorText);
    entryId = c.value.id;
  });

  it("public list read is shareable: s-maxage + max-age=0 + Vary + ETag", async () => {
    const res = await get("/posts");
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control") ?? "";
    assert.match(cc, /s-maxage=\d+/, `expected s-maxage, got "${cc}"`);
    assert.match(cc, /max-age=0/, "direct clients must keep revalidating");
    assert.match(res.headers.get("vary") ?? "", /authorization/i, "must declare per-token variance");
    assert.ok(res.headers.get("etag"), "ETag must survive the share path");
  });

  it("public single-entry read is shareable too", async () => {
    const res = await get(`/posts/${entryId}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage=\d+/);
    assert.match(res.headers.get("vary") ?? "", /authorization/i);
  });

  it("304 revalidation still works on the share path (same headers)", async () => {
    const first = await get("/posts");
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const res = await get("/posts", { "if-none-match": etag });
    assert.equal(res.status, 304);
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage=\d+/, "304 must repeat the cache policy");
  });

  it("a user-scoped read (x-user-token present) is NEVER marked shareable", async () => {
    // Invalid user token on a public collection — whatever the status, the
    // response must not carry s-maxage (identity can alter ref visibility).
    const res = await get("/posts", { "x-user-token": "not-a-real-jwt" });
    assert.doesNotMatch(res.headers.get("cache-control") ?? "", /s-maxage/, `status ${res.status} leaked s-maxage`);
  });

  it("the changes feed stays no-cache (freshness-sensitive polling)", async () => {
    const res = await get("/changes");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  it("errors are not cacheable (404 unknown collection)", async () => {
    const res = await get("/nope");
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.headers.get("cache-control") ?? "", /s-maxage/);
  });

  it("POST responses are not cacheable", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "inbox",
      publicWrite: true,
      fields: [{ name: "msg", label: "Msg", type: "text", required: true, publicRead: true }],
    });
    assert.ok(def.ok, def.errorText);
    const res = await fetch(`${BASE}/api/v1/inbox`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${p.deliveryToken}`,
        "content-type": "application/json",
        "x-forwarded-for": "10.9.9.9",
      },
      body: JSON.stringify({ msg: "hi" }),
    });
    assert.equal(res.status, 201);
    assert.doesNotMatch(res.headers.get("cache-control") ?? "", /s-maxage/);
  });
});
