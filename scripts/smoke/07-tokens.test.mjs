import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery, BASE } from "./helpers.mjs";

describe("token scopes", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("tokens");
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "body", label: "Body", type: "text", publicRead: true }],
    });
  });
  after(() => p.destroy());

  it("delivery-scoped token is rejected by MCP with a scope message", async () => {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
    assert.ok(/delivery-scoped/.test(await res.text()));
  });

  it("delivery-scoped token works on the delivery API", async () => {
    const r = await delivery(p.deliveryToken, "/notes");
    assert.equal(r.status, 200);
  });

  it("mcp token on the delivery API answers E_SCOPE with the mint hint (Stallion report)", async () => {
    // A valid-but-wrong-scope token must NOT read like a typo'd credential —
    // the operator of a broken live site needs the remedy named.
    const r = await delivery(p.mcpToken, "/notes");
    assert.equal(r.status, 401);
    assert.equal(r.json.code, "E_SCOPE");
    assert.match(r.json.error, /Settings → Tokens/, r.json.error);
    assert.match(r.json.error, /mcp-scoped/, r.json.error);
  });

  it("bogus token is 401 everywhere", async () => {
    const r = await delivery("agx_totally_bogus_token_000000", "/notes");
    assert.equal(r.status, 401);
    const m = await mcp("agx_totally_bogus_token_000000", "list_collections", {});
    assert.ok(!m.ok);
  });

  it("mcp token can read the full admin view (private fields included)", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [
        { name: "body", label: "Body", type: "text", publicRead: true },
        { name: "secret", label: "Secret", type: "text" },
      ],
    });
    await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { body: "b", secret: "s" } });
    const rows = await mcp(p.mcpToken, "query_entries", { collection: "notes" });
    assert.equal(rows.value.entries[0].data.secret, "s");
    const pub = await delivery(p.deliveryToken, "/notes");
    assert.ok(!("secret" in pub.json.data[0]));
  });
});
