import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql } from "./helpers.mjs";

// MT-1 / D2 — scoped MCP tokens. Enforcement is ONE check at the top of
// callTool, so these tests aim at the boundary rather than at every tool:
// the grandfather path, a granted scope, a missing scope, the refusal's
// usefulness, the always-open feedback channel, and the completeness of the
// map (a future tool added without a scope must be caught here, not in prod).
describe("scoped MCP tokens (MT-1/D2)", () => {
  let p;

  /** Mint a raw token row directly with a chosen scope set. */
  async function tokenWithScopes(scopes) {
    const raw = "agx_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(raw).digest("hex");
    await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label, scopes)
      VALUES (${p.id}, ${hash}, 'mcp', 'scope-test', ${scopes === null ? null : JSON.stringify(scopes)}::jsonb)`;
    return raw;
  }

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("token-scopes");
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "title", label: "T", type: "text", required: true }],
    });
  });
  after(() => p.destroy());

  it("GRANDFATHER: a null-scopes token keeps full access", async () => {
    // p.mcpToken is minted by the helper with no scopes — the legacy shape.
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "grandfathered",
      fields: [{ name: "x", label: "X", type: "text" }],
    });
    assert.ok(r.ok, `pre-scopes tokens must be unaffected: ${r.errorText}`);
  });

  it("a granted scope is allowed; a missing one is refused with E_SCOPE", async () => {
    const readOnly = await tokenWithScopes(["content.read", "observability.read"]);

    const allowed = await mcp(readOnly, "query_entries", { collection: "notes" });
    assert.ok(allowed.ok, `content.read must permit query_entries: ${allowed.errorText}`);

    const refused = await mcp(readOnly, "create_entry", {
      collection: "notes",
      data: { title: "should not land" },
    });
    assert.equal(refused.ok, false, "content.write is not granted — create must be refused");
    assert.match(refused.errorText, /\[E_SCOPE\]|E_SCOPE/);
  });

  it("the refusal NAMES the missing scope and what the token does have", async () => {
    const readOnly = await tokenWithScopes(["content.read"]);
    const r = await mcp(readOnly, "define_collection", {
      name: "nope",
      fields: [{ name: "x", label: "X", type: "text" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /schema\.manage/, "names the scope required");
    assert.match(r.errorText, /change the content model/, "explains it in consent language");
    assert.match(r.errorText, /content\.read/, "reports what the token actually grants");
  });

  it("ORIENTATION is not gated behind schema.manage", async () => {
    // The correction that makes scopes usable: a content-only token must be
    // able to discover the model, or every token needs schema.manage and the
    // whole vocabulary collapses.
    const contentOnly = await tokenWithScopes(["content.read", "content.write", "observability.read"]);
    for (const tool of ["list_collections", "describe_collection", "get_project_info"]) {
      const args = tool === "describe_collection" ? { name: "notes" } : {};
      const r = await mcp(contentOnly, tool, args);
      assert.ok(r.ok, `${tool} must work without schema.manage: ${r.errorText}`);
    }
  });

  it("send_feedback stays open to even a zero-scope token", async () => {
    const nothing = await tokenWithScopes([]);
    const r = await mcp(nothing, "send_feedback", {
      category: "friction",
      summary: "TEST: a maximally restricted token can still reach the wall",
    });
    assert.ok(r.ok, `the complaint channel must never be scope-gated: ${r.errorText}`);
    // ...while everything else is shut.
    const blocked = await mcp(nothing, "query_entries", { collection: "notes" });
    assert.equal(blocked.ok, false);
  });

  it("tokens.manage gates credential issuance", async () => {
    const noTokens = await tokenWithScopes(["content.read", "content.write"]);
    const r = await mcp(noTokens, "mint_delivery_token", { label: "should be refused" });
    assert.equal(r.ok, false, "minting credentials needs tokens.manage");
    assert.match(r.errorText, /tokens\.manage/);
  });

  it("COMPLETENESS: every advertised tool has a scope (or is deliberately unscoped)", async () => {
    // The guard that matters long-term: a tool added later without a map entry
    // would silently be callable by ANY scoped token. Fail here instead.
    const res = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/mcp`);
    const { tools } = await res.json();
    const { TOOL_SCOPE, UNSCOPED_TOOLS } = await import("../../lib/scopes.ts");
    const missing = tools.filter((t) => !(t in TOOL_SCOPE) && !UNSCOPED_TOOLS.has(t));
    assert.deepEqual(missing, [], `tools with no scope assignment: ${missing.join(", ")}`);
    // And nothing stale in the map.
    const stale = Object.keys(TOOL_SCOPE).filter((t) => !tools.includes(t));
    assert.deepEqual(stale, [], `TOOL_SCOPE lists tools that no longer exist: ${stale.join(", ")}`);
  });

  it("EXPIRY: a past expires_at makes the token resolve as unknown", async () => {
    const raw = "agx_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(raw).digest("hex");
    await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label, expires_at)
      VALUES (${p.id}, ${hash}, 'mcp', 'expired', now() - interval '1 hour')`;
    const r = await mcp(raw, "get_project_info", {});
    assert.equal(r.ok, false, "an expired token must not authenticate");
    // Indistinguishable from an unknown token — no oracle that says "merely lapsed".
    assert.match(r.errorText, /invalid project token|E_AUTH/);
  });
});
