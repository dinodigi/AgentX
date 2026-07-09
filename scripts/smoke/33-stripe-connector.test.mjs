import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// K1: Stripe as the third BYO-infra connector. The MCP surface reports it
// (status + non-secret publishable key) and NEVER the secret key.
const sql = neon(process.env.DATABASE_URL);

describe("stripe connector (K1)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("stripe-conn");
    // Seed as the admin would (config = non-secret pk; secret would be encrypted).
    await sql`INSERT INTO project_connectors (project_id, type, config, status)
      VALUES (${p.id}, 'stripe', ${JSON.stringify({ publishableKey: "pk_test_abc123" })}::jsonb, 'connected')
      ON CONFLICT (project_id, type) DO UPDATE SET config = EXCLUDED.config, status = 'connected'`;
  });
  after(async () => {
    await p.destroy();
  });

  it("list_connectors reports stripe with its publishable key, never a secret", async () => {
    const r = await mcp(p.mcpToken, "list_connectors", {});
    assert.ok(r.ok, r.errorText);
    const stripe = r.value.find((c) => c.type === "stripe");
    assert.ok(stripe, "stripe connector is listed");
    assert.equal(stripe.status, "connected");
    assert.equal(stripe.config.publishableKey, "pk_test_abc123");
    // No secret material anywhere in the payload.
    const dump = JSON.stringify(r.value);
    assert.ok(!/secretEnc|sk_|secret_enc/i.test(dump), "no secret leaks through list_connectors");
  });

  it("get_project_info advertises stripe as a connector", async () => {
    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(info.ok, info.errorText);
    assert.ok(info.value.connectors.some((c) => c.type === "stripe" && c.status === "connected"));
  });
});
