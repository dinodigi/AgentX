import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery, sql } from "./helpers.mjs";

// TOK-1: the agent-side token lifecycle — mint/list/revoke delivery tokens over
// MCP, closing the loop where get_client_code emitted a client that needed a
// credential no tool could produce. The security shape under test:
//   scope hard-fixed to delivery (never a parameter), parentage stamped on
//   every mint, cascade revoke as a DATABASE guarantee, per-project cap,
//   platform-events trail carrying ids and labels but never token values.
describe("delivery-token lifecycle over MCP (TOK-1)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("token-lifecycle");
  });
  after(() => p.destroy());

  it("mint → the token WORKS on delivery and is REFUSED on MCP", async () => {
    const r = await mcp(p.mcpToken, "mint_delivery_token", { label: "site-a" });
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.token, /^agx_/);
    assert.ok(r.value.tokenId);
    assert.match(r.value.handling, /never NEXT_PUBLIC/);

    // Usable where delivery tokens belong…
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      publicWrite: true,
      fields: [{ name: "body", label: "B", type: "text", required: true, publicRead: true }],
    });
    const post = await delivery(r.value.token, "/notes", { method: "POST", body: { body: "hi" } });
    assert.equal(post.status, 201, JSON.stringify(post.json));

    // …and rejected as an authoring credential, with the scope named.
    const asMcp = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${r.value.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_collections", arguments: {} } }),
    });
    assert.equal(asMcp.status, 401);
    const body = await asMcp.json();
    assert.equal(body.code, "E_SCOPE");
  });

  it("the tool surface can NEVER mint an mcp-scope token (no scope parameter exists)", async () => {
    // additionalProperties:false — a smuggled scope is a validation error, not an escalation.
    const r = await mcp(p.mcpToken, "mint_delivery_token", { label: "sneaky", scope: "mcp" });
    assert.equal(r.ok, false, "a scope argument must be rejected outright");
    // And every row this surface has created is delivery-scoped, by DB fact:
    const rows = await sql`SELECT DISTINCT scope FROM project_tokens
      WHERE project_id = ${p.id} AND minted_by_token_id IS NOT NULL`;
    for (const row of rows) assert.equal(row.scope, "delivery");
  });

  it("label is required; the mint is attributed in platform_events without the token value", async () => {
    const bare = await mcp(p.mcpToken, "mint_delivery_token", {});
    assert.equal(bare.ok, false);
    assert.match(bare.errorText, /label is required/i);

    const ev = await sql`SELECT type, actor_email, note FROM platform_events
      WHERE project_id = ${p.id} AND type = 'token_mint' ORDER BY created_at DESC LIMIT 1`;
    assert.ok(ev[0], "a token_mint platform event exists");
    assert.match(ev[0].actor_email, /^mcp-token:/);
    assert.doesNotMatch(ev[0].note ?? "", /agx_/, "the raw token must NEVER appear in the trail");
  });

  it("list shows origin (agentMinted) and never values; revoke kills the token within seconds", async () => {
    const list = await mcp(p.mcpToken, "list_delivery_tokens", {});
    assert.ok(list.ok, list.errorText);
    const mine = list.value.find((t) => t.label === "site-a");
    assert.ok(mine, JSON.stringify(list.value));
    assert.equal(mine.agentMinted, true);
    assert.equal(list.value.find((t) => t.label === "smoke")?.agentMinted, false, "console-seeded token reads human-minted");
    for (const t of list.value) assert.equal("token" in t, false, "listing never carries token values");

    const minted = await mcp(p.mcpToken, "mint_delivery_token", { label: "to-revoke" });
    const rev = await mcp(p.mcpToken, "revoke_delivery_token", { tokenId: minted.value.tokenId });
    assert.ok(rev.ok, rev.errorText);
    const post = await delivery(minted.value.token, "/notes", { method: "POST", body: { body: "zombie" } });
    assert.equal(post.status, 401, "a revoked token must stop working");
  });

  it("revoke cannot touch mcp-scoped tokens, even by id", async () => {
    const [mcpRow] = await sql`SELECT id FROM project_tokens
      WHERE project_id = ${p.id} AND scope = 'mcp' LIMIT 1`;
    const r = await mcp(p.mcpToken, "revoke_delivery_token", { tokenId: mcpRow.id });
    assert.equal(r.ok, false, "credential surgery on the master scope stays human");
    assert.match(r.errorText, /no delivery token/i);
  });

  it("CASCADE: deleting the minting token reaps its mints at the DATABASE level", async () => {
    const minted = await mcp(p.mcpToken, "mint_delivery_token", { label: "orphan-check" });
    assert.ok(minted.ok);
    const [before] = await sql`SELECT count(*)::int AS n FROM project_tokens WHERE id = ${minted.value.tokenId}`;
    assert.equal(before.n, 1);
    // Simulate revoking the compromised MCP token — raw SQL, so what's under
    // test is the FK, not app code that could be bypassed.
    const [parent] = await sql`SELECT minted_by_token_id FROM project_tokens WHERE id = ${minted.value.tokenId}`;
    await sql`DELETE FROM project_tokens WHERE id = ${parent.minted_by_token_id}`;
    const [after_] = await sql`SELECT count(*)::int AS n FROM project_tokens WHERE id = ${minted.value.tokenId}`;
    assert.equal(after_.n, 0, "the minted token must die with its minter — no surviving foothold");
  });

  it("the per-project cap refuses further mints and names the remedy", async () => {
    // The cascade test just deleted this project's mcp token — recreate the wiring
    // by using a fresh project (cheap, and keeps the cap math exact).
    const q = await createEphemeralProject("token-cap");
    try {
      // 1 seeded delivery token + 24 mints = 25 = cap.
      for (let i = 0; i < 24; i++) {
        const r = await mcp(q.mcpToken, "mint_delivery_token", { label: `bulk-${i}` });
        assert.ok(r.ok, `mint ${i}: ${r.errorText}`);
      }
      const over = await mcp(q.mcpToken, "mint_delivery_token", { label: "one-too-many" });
      assert.equal(over.ok, false);
      assert.match(over.errorText, /cap 25/);
      assert.match(over.errorText, /revoke_delivery_token/);
    } finally {
      await q.destroy();
    }
  });
});
