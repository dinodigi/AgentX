import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// HAv1 untested-surface probe → fixes: asset upload SVG/XSS + pre-buffer OOM.
describe("upload hardening: SVG block + oversize pre-check", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("upload-hardening");
    await mcp(p.mcpToken, "define_collection", {
      name: "rsvps",
      publicWrite: true,
      fields: [
        { name: "name", label: "Name", type: "text", required: true, publicRead: true },
        { name: "photo", label: "Photo", type: "asset", publicRead: true },
      ],
    });
  });
  after(() => p.destroy());

  const post = async (blob, filename) => {
    const fd = new FormData();
    fd.append("file", blob, filename);
    return fetch(`${BASE}/api/v1/rsvps/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}` },
      body: fd,
    });
  };

  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

  it("rejects an honest SVG (image/svg+xml)", async () => {
    const r = await post(new Blob([SVG], { type: "image/svg+xml" }), "x.svg");
    assert.equal(r.status, 422, await r.clone().text());
  });

  it("rejects SVG bytes smuggled under image/png", async () => {
    const r = await post(new Blob([SVG], { type: "image/png" }), "x.png");
    assert.equal(r.status, 422, await r.clone().text());
  });

  it("still accepts a genuine raster image", async () => {
    // PNG magic header — not SVG, allowed type.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const r = await post(new Blob([png], { type: "image/png" }), "ok.png");
    assert.equal(r.status, 201, await r.clone().text());
    const asset = await r.json();
    assert.ok(asset.id && asset.url);
  });

  it("rejects an oversized upload (413) before buffering the body", async () => {
    const big = new Uint8Array(11 * 1024 * 1024); // > 10 MiB cap + slack
    const r = await post(new Blob([big], { type: "text/plain" }), "big.txt");
    assert.equal(r.status, 413, `expected 413, got ${r.status}`);
  });
});
