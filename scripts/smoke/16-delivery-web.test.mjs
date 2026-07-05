import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery, BASE } from "./helpers.mjs";

describe("delivery web behavior: error codes, ETags, public uploads", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("delivery-web");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "Title", type: "text", required: true, publicRead: true }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "rsvps",
      publicWrite: true,
      fields: [
        { name: "name", label: "Name", type: "text", required: true, publicRead: true },
        { name: "photo", label: "Photo", type: "asset", publicRead: true },
      ],
    });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Hello" } });
  });
  after(() => p.destroy());

  it("every error carries the {error, code} envelope", async () => {
    const notFound = await delivery(p.deliveryToken, "/nope");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.code, "E_NOT_FOUND");

    const badFilter = await delivery(p.deliveryToken, "/posts?secret=x");
    assert.equal(badFilter.status, 422);
    assert.equal(badFilter.json.code, "E_VALIDATION");

    const badToken = await delivery("agx_bogus", "/posts");
    assert.equal(badToken.status, 401);
    assert.equal(badToken.json.code, "E_AUTH");

    const writeOff = await delivery(p.deliveryToken, "/posts", {
      method: "POST",
      body: { title: "x" },
    });
    assert.equal(writeOff.status, 403);
    assert.equal(writeOff.json.code, "E_SCOPE");

    const invalid = await delivery(p.deliveryToken, "/rsvps", { method: "POST", body: {} });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.json.code, "E_VALIDATION");
  });

  it("GETs carry strong ETags; If-None-Match gets 304 until data changes", async () => {
    const url = `${BASE}/api/v1/posts`;
    const headers = { authorization: `Bearer ${p.deliveryToken}` };

    const first = await fetch(url, { headers });
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag && etag.startsWith('"'), "expected a strong ETag");
    assert.equal(first.headers.get("cache-control"), "no-cache");

    const revalidate = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
    assert.equal(revalidate.status, 304);
    assert.equal(revalidate.headers.get("etag"), etag);
    assert.equal((await revalidate.text()).length, 0);
    assert.equal(revalidate.headers.get("access-control-allow-origin"), "*");

    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Second" } });
    const changed = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
    assert.equal(changed.status, 200, "stale ETag must re-serve the body");
    assert.notEqual(changed.headers.get("etag"), etag);

    // Single-entry GET revalidates the same way.
    const list = await changed.json();
    const one = await fetch(`${url}/${list.data[0].id}`, { headers });
    const oneTag = one.headers.get("etag");
    const oneAgain = await fetch(`${url}/${list.data[0].id}`, {
      headers: { ...headers, "if-none-match": oneTag },
    });
    assert.equal(oneAgain.status, 304);
  });

  it("public uploads: multipart in, {id,url} out, referenced by the form submit", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["hello upload"], { type: "text/plain" }), "note.txt");
    const up = await fetch(`${BASE}/api/v1/rsvps/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}` },
      body: fd,
    });
    assert.equal(up.status, 201, await up.clone().text());
    const asset = await up.json();
    assert.ok(asset.id && asset.url);

    const submit = await delivery(p.deliveryToken, "/rsvps", {
      method: "POST",
      body: { name: "Ada", photo: asset.id },
    });
    assert.equal(submit.status, 201);

    const rows = await delivery(p.deliveryToken, "/rsvps");
    assert.deepEqual(rows.json.data[0].photo, { id: asset.id, url: asset.url });
  });

  it("upload gates: type allowlist, no asset field, publicWrite off, bad ids 404", async () => {
    const evil = new FormData();
    evil.append("file", new Blob(["MZ"], { type: "application/x-msdownload" }), "evil.exe");
    const rejected = await fetch(`${BASE}/api/v1/rsvps/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}` },
      body: evil,
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).code, "E_VALIDATION");

    const fd = new FormData();
    fd.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    const noAssetField = await fetch(`${BASE}/api/v1/posts/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}` },
      body: fd,
    });
    assert.equal(noAssetField.status, 403);
    assert.match((await noAssetField.json()).error, /no asset fields/);

    // Stray GET to /uploads (and any non-uuid id) is a clean 404, not a 500.
    const stray = await delivery(p.deliveryToken, "/rsvps/uploads");
    assert.equal(stray.status, 404);
    assert.equal(stray.json.code, "E_NOT_FOUND");
  });
});
