import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// K2a: declarative checkout config on collections — define-time validation only,
// no Stripe network needed.
const sql = neon(process.env.DATABASE_URL);

const productFields = [
  { name: "title", label: "T", type: "text", required: true, publicRead: true },
  { name: "price_id", label: "Price", type: "text", publicRead: true },
];
const checkout = { priceField: "price_id", successUrl: "https://shop.example.com/ok", cancelUrl: "https://shop.example.com/no" };

describe("declarative checkout config (K2a)", () => {
  let p;
  const define = (extra) =>
    mcp(p.mcpToken, "define_collection", { name: "products", fields: productFields, ...extra });

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("checkout-cfg");
    // Seed the stripe connector for p BEFORE any getConnector caches a null
    // (getConnector is unstable_cache'd per project; direct SQL can't bust it).
    await sql`INSERT INTO project_connectors (project_id, type, config, status)
      VALUES (${p.id}, 'stripe', ${JSON.stringify({ publishableKey: "pk_test_x" })}::jsonb, 'connected')
      ON CONFLICT (project_id, type) DO UPDATE SET status = 'connected'`;
  });
  after(async () => {
    await p.destroy();
  });

  it("checkout without the Stripe connector is E_CONNECTOR_REQUIRED", async () => {
    // A fresh project with no connector — its own cache key, never polluted by p.
    const noConn = await createEphemeralProject("checkout-noconn");
    try {
      const r = await mcp(noConn.mcpToken, "define_collection", { name: "products", fields: productFields, checkout });
      assert.ok(!r.ok && /E_CONNECTOR_REQUIRED/.test(r.errorText) && /Stripe/.test(r.errorText), r.errorText);
    } finally {
      await noConn.destroy();
    }
  });

  it("with the connector: define + describe round-trips the checkout config", async () => {
    const r = await define({ checkout });
    assert.ok(r.ok, r.errorText);
    const d = await mcp(p.mcpToken, "describe_collection", { name: "products" });
    assert.deepEqual(d.value.checkout, checkout);
  });

  it("rejects a non-text/absent priceField and a non-https URL", async () => {
    const badField = await define({ checkout: { ...checkout, priceField: "nope" } });
    assert.ok(!badField.ok && /priceField/.test(badField.errorText), badField.errorText);

    const badUrl = await define({ checkout: { ...checkout, successUrl: "http://insecure.example.com" } });
    assert.ok(!badUrl.ok && /successUrl.*https/.test(badUrl.errorText), badUrl.errorText);
  });

  it("rejects checkout on a non-public collection — sellable ⇒ publicly readable", async () => {
    const owned = await define({
      fields: [...productFields, { name: "owner", label: "O", type: "text" }],
      access: { read: "owner", write: "owner", ownerField: "owner" },
      checkout,
    });
    assert.ok(!owned.ok && /access\.read.*public/.test(owned.errorText), owned.errorText);
  });

  it("re-defining a sellable collection to a private access.read is rejected (runs on every write)", async () => {
    // products is already defined public+checkout from the round-trip test; flip it.
    const flip = await define({
      fields: [...productFields, { name: "owner", label: "O", type: "text" }],
      access: { read: "owner", write: "owner", ownerField: "owner" },
      checkout,
    });
    assert.ok(!flip.ok && /access\.read.*public/.test(flip.errorText), flip.errorText);
  });

  it("'checkout' is a reserved collection name", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "checkout",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
    });
    assert.ok(!r.ok && /reserved/.test(r.errorText), r.errorText);
  });
});
