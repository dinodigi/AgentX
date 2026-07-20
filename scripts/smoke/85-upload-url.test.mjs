import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// Wall report (Fatsoz 5521f4af): inline base64 costs ~70k tokens per image —
// upload_asset now accepts a `url` fetched server-side. Prove: fetch+store
// works end to end (loopback http is the sanctioned test/dev path), SSRF
// guards refuse private hosts, redirects are bounded, and the arg contract
// (exactly one of dataBase64|url) holds.
describe("upload_asset by url", () => {
  let p, srv, base;
  // A 1x1 PNG — real magic bytes so the image type checks pass.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("upload-url");
    srv = createServer((req, res) => {
      if (req.url === "/img.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
        res.end(PNG);
      } else if (req.url === "/hop") {
        res.writeHead(302, { location: "/img.png" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/huge") {
        // Claims 11MB — must be refused on the declared length alone.
        res.writeHead(200, { "content-type": "image/png", "content-length": 11 * 1024 * 1024 });
        res.end(PNG);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(async () => {
    srv.close();
    await p.destroy();
  });

  it("fetches a url server-side and stores the asset (content type inferred)", async () => {
    const r = await mcp(p.mcpToken, "upload_asset", { filename: "seeded.png", url: `${base}/img.png` });
    assert.ok(r.ok, r.errorText);
    assert.ok(r.value.id && r.value.url, JSON.stringify(r.value));
  });

  it("follows a redirect hop (re-validated) to the file", async () => {
    const r = await mcp(p.mcpToken, "upload_asset", { filename: "hopped.png", url: `${base}/hop` });
    assert.ok(r.ok, r.errorText);
  });

  it("refuses private/reserved hosts (SSRF guard)", async () => {
    for (const bad of ["https://10.0.0.8/x.png", "https://192.168.1.1/x.png", "https://169.254.169.254/latest/meta-data"]) {
      const r = await mcp(p.mcpToken, "upload_asset", { filename: "x.png", url: bad });
      assert.equal(r.ok, false, bad);
      assert.match(r.errorText, /private|reserved|resolve/i, `${bad}: ${r.errorText}`);
    }
  });

  it("refuses plain http on non-loopback hosts", async () => {
    const r = await mcp(p.mcpToken, "upload_asset", { filename: "x.png", url: "http://example.com/x.png" });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /https/i, r.errorText);
  });

  it("bounds redirects and declared size", async () => {
    const loop = await mcp(p.mcpToken, "upload_asset", { filename: "x.png", url: `${base}/loop` });
    assert.equal(loop.ok, false);
    assert.match(loop.errorText, /redirect/i, loop.errorText);
    const huge = await mcp(p.mcpToken, "upload_asset", { filename: "x.png", url: `${base}/huge` });
    assert.equal(huge.ok, false);
    assert.match(huge.errorText, /too large/i, huge.errorText);
  });

  it("arg contract: exactly one of dataBase64 | url; contentType required with base64", async () => {
    const both = await mcp(p.mcpToken, "upload_asset", {
      filename: "x.png", url: `${base}/img.png`, dataBase64: PNG.toString("base64"), contentType: "image/png",
    });
    assert.equal(both.ok, false);
    const neither = await mcp(p.mcpToken, "upload_asset", { filename: "x.png" });
    assert.equal(neither.ok, false);
    const noType = await mcp(p.mcpToken, "upload_asset", { filename: "x.png", dataBase64: PNG.toString("base64") });
    assert.equal(noType.ok, false);
    assert.match(noType.errorText, /contentType/i, noType.errorText);
    // The classic inline path still works untouched.
    const inline = await mcp(p.mcpToken, "upload_asset", {
      filename: "inline.png", dataBase64: PNG.toString("base64"), contentType: "image/png",
    });
    assert.ok(inline.ok, inline.errorText);
  });
});
