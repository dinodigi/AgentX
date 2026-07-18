import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// v2 Track 5: audit_site — the site-wide SEO loop (multi-URL, bounded,
// SSRF-guarded per fetch; a dead page is a per-page error, not a failed audit).
describe("seo v2: audit_site", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("audit-site");
  });

  it("is gated until the seo plugin is enabled", async () => {
    const r = await mcp(p.mcpToken, "audit_site", { urls: ["https://example.com/"] });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not enabled.*enable_plugin/i);
  });

  it("audits multiple pages with per-page results + summary; dead pages don't fail the audit", async () => {
    const e = await mcp(p.mcpToken, "enable_plugin", { id: "seo" });
    assert.ok(e.ok, e.errorText);
    const r = await mcp(p.mcpToken, "audit_site", {
      urls: ["https://example.com/", "https://example.com/definitely-missing-404"],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.pages.length, 2);
    const [ok404] = [r.value.pages[1]];
    assert.equal(typeof r.value.pages[0].score, "number");
    assert.ok(ok404.error, "the 404 page must carry a per-page error");
    assert.equal(r.value.summary.audited, 1);
    assert.equal(r.value.summary.failed, 1);
    assert.equal(r.value.summary.worst, "https://example.com/");
    assert.equal(typeof r.value.summary.averageScore, "number");
  });

  it("no urls and no sitemap → clear error; bad sitemap → clear error", async () => {
    const none = await mcp(p.mcpToken, "audit_site", {});
    assert.equal(none.ok, false);
    assert.match(none.errorText, /provide urls\[\] or a sitemapUrl/i);
    const bad = await mcp(p.mcpToken, "audit_site", { sitemapUrl: "https://example.com/" });
    assert.equal(bad.ok, false);
    assert.match(bad.errorText, /no <loc> entries|sitemap/i, bad.errorText);
  });
});
