import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// Track 3: the SEO plugin — the first TOOL-carrying plugin, proving the
// enablement gate. fetch_page/score_page audit a live page (SSRF-guarded);
// findings map to the `seo` group fields the plugin's structure adds.
// Audit target: example.com — a real EXTERNAL crawl (the tool's actual usage
// shape; the dev server's own pages sit behind Clerk's dev-instance handshake
// redirect, a dev-only artifact production doesn't have).
describe("seo plugin (Track 3)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("seo-plugin");
  });

  it("tools are GATED until the plugin is enabled", async () => {
    const r = await mcp(p.mcpToken, "score_page", { url: `${BASE}/` });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not enabled.*enable_plugin/i, r.errorText);
  });

  it("get_plugin seo carries tools + structure + acceptance", async () => {
    const r = await mcp(p.mcpToken, "get_plugin", { id: "seo" });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.tools, ["fetch_page", "score_page", "audit_site"]); // v2 adds the site-wide loop
    assert.match(r.value.structure.reconcile, /do not create it/i);
    assert.ok(r.value.acceptance.length >= 3);
  });

  it("after enabling, score_page grades a live page with actionable findings", async () => {
    const e = await mcp(p.mcpToken, "enable_plugin", { id: "seo" });
    assert.ok(e.ok, e.errorText);
    const r = await mcp(p.mcpToken, "score_page", { url: "https://example.com/" });
    assert.ok(r.ok, r.errorText);
    assert.equal(typeof r.value.score, "number");
    assert.ok(r.value.score >= 0 && r.value.score <= 100);
    assert.ok(Array.isArray(r.value.findings));
    assert.equal(r.value.head.title, "Example Domain");
    assert.ok(r.value.score < 100, "example.com lacks og/description — findings expected");
    for (const f of r.value.findings) {
      assert.ok(["critical", "warn", "info"].includes(f.severity));
      assert.ok(f.fix.length > 0, "every finding carries an actionable fix");
    }
  });

  it("fetch_page returns the raw head facts", async () => {
    const r = await mcp(p.mcpToken, "fetch_page", { url: "https://example.com/" });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.title, "Example Domain");
    assert.equal(typeof r.value.h1Count, "number");
    assert.ok(r.value.h1Count >= 1);
    assert.ok("metaDescription" in r.value);
    assert.ok("canonical" in r.value);
  });

  it("a non-HTML target errors cleanly (E_UPSTREAM), not a crash", async () => {
    const r = await mcp(p.mcpToken, "score_page", { url: `${BASE}/api/health` });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not an HTML page/i, r.errorText);
  });

  // REGRESSION (Stallion field report 2026-07-20): lengths were measured on the
  // HTML SOURCE, so a 59-char title carrying two "&" measured 67 and got dinged
  // for being over 60. Served locally because the case needs exact control of
  // the entity markup — the SSRF guard is production-gated, so 127.0.0.1 is a
  // legitimate target against a dev server.
  it("measures title/description length on DECODED text, not entity source", async () => {
    const title = "Roofing & Siding Contractors & Emergency Repairs Norfolk VA"; // 59 real
    const encoded = title.replace(/&/g, "&amp;"); // 67 in source
    assert.equal(title.length, 59);
    assert.equal(encoded.length, 67);

    const html = `<!doctype html><html lang="en"><head>
<title>${encoded}</title>
<meta name="description" content="Trusted roofing &amp; siding contractors serving Tidewater since 1998 &mdash; free estimates &amp; fast repairs today.">
<link rel="canonical" href="https://x.test/svc?a=1&amp;b=2">
<meta property="og:title" content="Roofing &amp; Siding">
<meta property="og:description" content="Roofing and siding, done right.">
<meta property="og:image" content="https://x.test/card.png?w=1200&amp;h=630">
<meta name="viewport" content="width=device-width">
<script type="application/ld+json">{}</script>
</head><body><h1>hi</h1></body></html>`;

    const { createServer } = await import("node:http");
    const srv = createServer((_q, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    });
    await new Promise((ok) => srv.listen(4599, "127.0.0.1", ok));
    try {
      const r = await mcp(p.mcpToken, "score_page", { url: "http://127.0.0.1:4599/" });
      assert.ok(r.ok, r.errorText);
      assert.equal(r.value.head.title, title, "title comes back as rendered text, entities decoded");
      assert.equal(
        r.value.findings.find((f) => f.check === "title"),
        undefined,
        "a 59-char title must not be dinged just because its source form is 67",
      );
      // Entity decoding also repairs correctly-escaped URLs.
      assert.equal(r.value.head.canonical, "https://x.test/svc?a=1&b=2");
      assert.equal(r.value.head.ogImage, "https://x.test/card.png?w=1200&h=630");
      // &mdash; is one character, not eight.
      assert.equal(r.value.head.metaDescription.length, 104);
    } finally {
      srv.close();
    }
  });
});
