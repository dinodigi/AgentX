import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// J1: on-demand image transforms with R2-cached derivatives + durable abuse
// bounds (ladder snap, per-asset budget, per-IP rate limit). J2: contentType on
// resolved assets + get_project_info discoverability.
const LADDER = [64, 96, 128, 256, 320, 480, 640, 768, 960, 1200, 1600, 2000];
const BUDGET = 40;

describe("image transforms (J1/J2)", () => {
  let p, imgId, textId, budgetId;

  async function uploadImage(name, w, h) {
    const bytes = await sharp({
      create: { width: w, height: h, channels: 3, background: { r: 200, g: 60, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    const up = await mcp(p.mcpToken, "upload_asset", {
      filename: name,
      contentType: "image/jpeg",
      dataBase64: bytes.toString("base64"),
    });
    assert.ok(up.ok, up.errorText);
    return up.value.id;
  }

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("image-xf");
    imgId = await uploadImage("pic.jpg", 800, 600);
    budgetId = await uploadImage("budget.jpg", 400, 400);
    const t = await mcp(p.mcpToken, "upload_asset", {
      filename: "note.txt",
      contentType: "text/plain",
      dataBase64: Buffer.from("hello").toString("base64"),
    });
    textId = t.value.id;
  });
  after(async () => {
    // delete_asset prefix-deletes each asset's derivatives from R2 too.
    for (const id of [imgId, budgetId, textId]) {
      await mcp(p.mcpToken, "delete_asset", { id }).catch(() => {});
    }
    await p.destroy();
  });

  const xf = (path, ip) =>
    fetch(`${BASE}/api/v1${path}`, { redirect: "manual", headers: ip ? { "x-forwarded-for": ip } : {} });

  it("resizes → 302 to an R2 derivative (w snaps up the ladder); 2nd request is a cache hit", async () => {
    const r1 = await xf(`/assets/${imgId}/image?w=300`);
    assert.equal(r1.status, 302);
    const loc = r1.headers.get("location");
    assert.match(loc, /\/_t\/w320\.webp$/, "300 snaps up to 320, default webp");
    // Follow to R2 and verify the actual bytes.
    const img = await fetch(loc);
    assert.equal(img.status, 200);
    const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 320);
    // Second request: same deterministic key, still a 302 (served from cache).
    const r2 = await xf(`/assets/${imgId}/image?w=300`);
    assert.equal(r2.status, 302);
    assert.equal(r2.headers.get("location"), loc);
  });

  it("both dims + fit + jpeg → canonical key; single dim + fit → 422", async () => {
    const r = await xf(`/assets/${imgId}/image?w=200&h=180&fit=inside&format=jpeg`);
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /\/_t\/w256h256-inside\.jpeg$/, "200→256, 180→256");

    const bad = await xf(`/assets/${imgId}/image?w=300&fit=cover`);
    assert.equal(bad.status, 422);
    const body = await bad.json();
    assert.match(body.error, /fit/);
  });

  it("no dims → 422; a non-image asset → 422; unknown id → 404", async () => {
    const noDims = await xf(`/assets/${imgId}/image?format=webp`);
    assert.equal(noDims.status, 422);
    const text = await xf(`/assets/${textId}/image?w=100`);
    assert.equal(text.status, 422);
    assert.match((await text.json()).error, /not a transformable/);
    const missing = await xf(`/assets/00000000-0000-4000-8000-000000000000/image?w=100`);
    assert.equal(missing.status, 404);
  });

  it("SVG bytes uploaded as image/jpeg are refused (content sniff, not declared type)", async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const up = await mcp(p.mcpToken, "upload_asset", {
      filename: "evil.jpg",
      contentType: "image/jpeg", // lies — passes the declared-type gate
      dataBase64: svg.toString("base64"),
    });
    assert.ok(up.ok, up.errorText);
    const r = await xf(`/assets/${up.value.id}/image?w=100`);
    assert.equal(r.status, 422, "SVG bytes must never reach sharp's librsvg path");
    assert.match((await r.json()).error, /raster/);
    await mcp(p.mcpToken, "delete_asset", { id: up.value.id }).catch(() => {});
  });

  it("per-asset derivative budget: past 40 distinct variants → 429 (distinct IPs dodge rate limits)", async () => {
    const combos = [];
    for (const fmt of ["webp", "jpeg"]) for (const w of LADDER) combos.push(`w=${w}&format=${fmt}`);
    for (const fmt of ["webp", "jpeg"]) for (const h of LADDER) combos.push(`h=${h}&format=${fmt}`);
    let generated = 0;
    let budget429 = false;
    for (let i = 0; i < combos.length; i++) {
      const r = await xf(`/assets/${budgetId}/image?${combos[i]}`, `10.9.${i}.1`);
      if (r.status === 302) generated++;
      else if (r.status === 429) {
        budget429 = /budget/.test((await r.json()).error);
        break;
      }
    }
    assert.ok(generated >= BUDGET, `generated ${generated} derivatives before stopping`);
    assert.ok(budget429, "requesting a NEW variant past the 40-derivative budget returns a budget 429");
  });

  it("J2: resolved asset fields carry contentType", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "gallery",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "hero", label: "H", type: "asset", publicRead: true },
      ],
    });
    const e = await mcp(p.mcpToken, "create_entry", { collection: "gallery", data: { title: "x", hero: imgId } });
    const got = await mcp(p.mcpToken, "get_entry", { collection: "gallery", id: e.value.id });
    assert.equal(got.value.data.hero.contentType, "image/jpeg", "resolved asset includes contentType");
    assert.ok(got.value.data.hero.url, "and still the url");

    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.match(info.value.deliveryApi.images, /assets\/\{id\}\/image/);
    assert.match(info.value.deliveryApi.images, /40/);
  });
});
