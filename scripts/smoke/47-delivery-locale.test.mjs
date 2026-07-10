import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// J6: delivery ?locale= — switches which variant localized fields serve, with
// per-variant fallback to the default; unknown locales 422 listing supported.

describe("delivery ?locale= (J6)", () => {
  let p, id;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("delivery-locale");
    const set = await mcp(p.mcpToken, "set_locales", { default: "en", supported: ["en", "de"] });
    assert.ok(set.ok, set.errorText);
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "pages",
      displayName: "Pages",
      fields: [
        { name: "title", label: "Title", type: "text", localized: true, required: true, publicRead: true },
        { name: "teaser", label: "Teaser", type: "text", localized: true, publicRead: true },
        { name: "slug", label: "Slug", type: "text", publicRead: true },
      ],
    });
    assert.ok(def.ok, def.errorText);
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: {
        title: { en: "Welcome", de: "Willkommen" },
        teaser: { en: "english only" }, // no de variant → falls back
        slug: "home",
      },
    });
    assert.ok(c.ok, c.errorText);
    id = c.value.id;
  });
  after(async () => {
    await p.destroy();
  });

  it("no ?locale serves the default locale", async () => {
    const r = await delivery(p.deliveryToken, "/pages");
    assert.equal(r.status, 200);
    const e = r.json.data.find((x) => x.id === id);
    assert.equal(e.title, "Welcome");
    assert.equal(e.teaser, "english only");
  });

  it("?locale=de switches, with per-variant fallback to the default", async () => {
    const r = await delivery(p.deliveryToken, "/pages?locale=de");
    assert.equal(r.status, 200);
    const e = r.json.data.find((x) => x.id === id);
    assert.equal(e.title, "Willkommen", "de variant served");
    assert.equal(e.teaser, "english only", "missing de variant falls back to default");
    assert.equal(e.slug, "home", "non-localized fields untouched");
  });

  it("single GET honors ?locale= the same way", async () => {
    const r = await delivery(p.deliveryToken, `/pages/${id}?locale=de`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.title, "Willkommen");
    assert.equal(r.json.data.teaser, "english only");
  });

  it("unknown locale 422s listing supported + default (list and single)", async () => {
    for (const path of ["/pages?locale=fr", `/pages/${id}?locale=fr`]) {
      const r = await delivery(p.deliveryToken, path);
      assert.equal(r.status, 422, path);
      assert.match(r.json.error, /unknown locale "fr"/);
      assert.match(r.json.error, /en, de/);
      assert.match(r.json.error, /default en/);
    }
  });

  it("?locale= on a project without locales 422s with a clear message", async () => {
    const p2 = await createEphemeralProject("no-locale-param");
    try {
      const def = await mcp(p2.mcpToken, "define_collection", {
        name: "things",
        displayName: "Things",
        fields: [{ name: "name", label: "Name", type: "text", publicRead: true }],
      });
      assert.ok(def.ok, def.errorText);
      const r = await delivery(p2.deliveryToken, "/things?locale=en");
      assert.equal(r.status, 422);
      assert.match(r.json.error, /no locales configured/);
    } finally {
      await p2.destroy();
    }
  });

  it("locale is not treated as a filter field", async () => {
    // Would 422 as "unknown or non-public filter field" if the skip list missed it.
    const r = await delivery(p.deliveryToken, "/pages?locale=en&slug=home");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 1);
  });

  it("ETags differ per locale (cache correctness)", async () => {
    const en = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/pages?locale=en`, {
      headers: { authorization: `Bearer ${p.deliveryToken}` },
    });
    const de = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/pages?locale=de`, {
      headers: { authorization: `Bearer ${p.deliveryToken}` },
    });
    assert.equal(en.status, 200);
    assert.equal(de.status, 200);
    assert.notEqual(en.headers.get("etag"), de.headers.get("etag"));
  });
});
