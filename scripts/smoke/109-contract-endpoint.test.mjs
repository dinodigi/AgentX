import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// DX-2 — the public contract endpoint, born from wall 15e5783b: the XVibe brief
// was a COPY of the contract, it froze pre-CP5 semantics, and an integrator
// planned against the stale copy. /api/contract renders from the live TOOL_DEFS
// at request time, so there is nothing to forget to regenerate.
describe("DX-2 — /api/contract serves the live contract, unauthenticated", () => {
  let md;

  before(async () => {
    await ensureServer();
    const res = await fetch(`${BASE}/api/contract`);
    assert.equal(res.status, 200, "public — no token, no Clerk redirect");
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    md = await res.text();
  });

  it("serves the CURRENT semantics — the exact drift that burned the reporter cannot recur", () => {
    // The stale copy said access.write "REPLACES the anonymous path"; CP5 shipped
    // composition. The live endpoint must carry the composed truth…
    assert.match(md, /they COMPOSE, per verb/);
    // …and must never again carry the pre-CP5 phrasing.
    assert.ok(
      !md.includes("REPLACES the anonymous path"),
      "the pre-CP5 semantics are back in the contract — this is wall 15e5783b recurring",
    );
    // Spot-check it is the full rendering, not a stub.
    assert.match(md, /## `define_collection`/);
    assert.match(md, /## `get_project_info`/);
  });

  it("?format=json is the verbatim tools/list payload", async () => {
    const res = await fetch(`${BASE}/api/contract?format=json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.tools) && body.tools.length >= 60, `expected the full registry, got ${body.tools?.length}`);
    const names = new Set(body.tools.map((t) => t.name));
    assert.ok(names.has("define_collection") && names.has("send_feedback"));
  });

  it("markdown and json agree on the tool count — one renderer, no second copy", () => {
    const indexCount = (md.match(/^- `/gm) ?? []).length;
    assert.ok(indexCount >= 60, `tool index lists ${indexCount}`);
  });

  it("/api/docs/hooks serves the hooks reference; unknown docs 404 with the list, never the filesystem", async () => {
    const ok = await fetch(`${BASE}/api/docs/hooks`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /text\/markdown/);
    const text = await ok.text();
    assert.ok(text.length > 500, "expected the real hooks doc");

    // The allowlist is the security boundary: docs/ also holds internal plans
    // and PM state, and a traversal or a guessed slug must find a 404, not a file.
    for (const probe of ["BACKLOG", "..%2Fpm%2FSTATUS", "hooks.md", "../../.env"]) {
      const res = await fetch(`${BASE}/api/docs/${probe}`);
      assert.equal(res.status, 404, `"${probe}" must not resolve`);
      const body = await res.json().catch(() => null);
      assert.ok(body?.code === "E_NOT_FOUND" || body === null, "structured refusal");
    }
  });

  it("get_project_info now points at the URLS, and the repo-only reference is gone", async () => {
    const p = await createEphemeralProject("contract-endpoint");
    try {
      const r = await mcp(p.mcpToken, "get_project_info", {});
      assert.ok(r.ok, r.errorText);
      assert.match(r.value.urls.contract, /\/api\/contract$/);
      assert.match(r.value.urls.hooksDoc, /\/api\/docs\/hooks$/);
      const blob = JSON.stringify(r.value);
      assert.ok(
        !blob.includes("in the AgentX repo"),
        "a repo-only doc reference survives — an API consumer cannot fetch a repo path",
      );
    } finally {
      await p.destroy();
    }
  });
});
