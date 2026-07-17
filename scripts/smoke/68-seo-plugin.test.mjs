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
    assert.deepEqual(r.value.tools, ["fetch_page", "score_page"]);
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
});
