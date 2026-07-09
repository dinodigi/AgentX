import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import {
  ensureServer,
  createEphemeralProject,
  connectStripe,
  mcp,
  delivery,
  randomUUID,
} from "./helpers.mjs";
import { startStripeMock } from "./stripe-mock.mjs";

// K2b: POST /v1/checkout turns a cart of entry ids + quantities into a Stripe
// Checkout Session. Prices are SERVER-SIDE (the collection's priceField); the
// client sends only ids + quantities. Runs against the in-process Stripe mock
// (the dev server must have STRIPE_API_BASE=http://localhost:4242).
const sql = neon(process.env.DATABASE_URL);

const productFields = [
  { name: "title", label: "T", type: "text", required: true, publicRead: true },
  { name: "price_id", label: "Price", type: "text", publicRead: true },
];
const checkout = {
  priceField: "price_id",
  successUrl: "https://shop.example.com/ok",
  cancelUrl: "https://shop.example.com/no",
};

describe("checkout endpoint (K2b)", () => {
  let p, mock;
  let aaa, bbb, badPrice;

  before(async () => {
    await ensureServer();
    mock = await startStripeMock();
    p = await createEphemeralProject("checkout-ep");
    // Seed the connector BEFORE define_collection (validateCheckout → getConnector
    // caches; direct SQL can't bust it, so seed first).
    await connectStripe(p.id, { sk: "sk_test_endpoint" });
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "products",
      fields: productFields,
      checkout,
    });
    assert.ok(def.ok, def.errorText);
    aaa = (await mcp(p.mcpToken, "create_entry", { collection: "products", data: { title: "A", price_id: "price_aaa" } })).value.id;
    bbb = (await mcp(p.mcpToken, "create_entry", { collection: "products", data: { title: "B", price_id: "price_bbb" } })).value.id;
    badPrice = (await mcp(p.mcpToken, "create_entry", { collection: "products", data: { title: "C", price_id: "not_a_price" } })).value.id;
  });
  after(async () => {
    await mock.close();
    await p.destroy();
  });

  it("builds a session from server-side Price ids and returns the redirect url", async () => {
    mock.reset();
    const r = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: aaa, quantity: 2 }, { id: bbb, quantity: 1 }] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.match(r.json.url, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    assert.match(r.json.sessionId, /^cs_test_/);

    const sent = mock.requests.find((q) => q.path === "/v1/checkout/sessions");
    assert.ok(sent, "Stripe mock received a session create");
    assert.equal(sent.auth, "Bearer sk_test_endpoint", "uses the decrypted connector secret");
    assert.equal(sent.form.mode, "payment");
    assert.equal(sent.form["line_items[0][price]"], "price_aaa");
    assert.equal(sent.form["line_items[0][quantity]"], "2");
    assert.equal(sent.form["line_items[1][price]"], "price_bbb");
    assert.equal(sent.form["line_items[1][quantity]"], "1");
    assert.equal(sent.form.success_url, "https://shop.example.com/ok");
    assert.equal(sent.form.cancel_url, "https://shop.example.com/no");
    // Webhook re-derives the project from the URL path, never metadata: only
    // the collection travels, never projectId.
    assert.equal(sent.form["metadata[collection]"], "products");
    assert.ok(!("metadata[projectId]" in sent.form), "must not leak projectId in metadata");
  });

  it("ignores any client-supplied amount/price — money is server-authoritative", async () => {
    mock.reset();
    const r = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      // A hostile client tacks on price + amount fields; the schema strips them.
      body: { collection: "products", items: [{ id: aaa, quantity: 1, price: "price_HACK", amount: 1 }] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const sent = mock.requests.find((q) => q.path === "/v1/checkout/sessions");
    assert.equal(sent.form["line_items[0][price]"], "price_aaa", "server price wins over client price");
    assert.ok(!Object.keys(sent.form).some((k) => /amount/.test(k)), "no client amount reaches Stripe");
  });

  it("an absent entry id is an indistinguishable 422 (never confirms existence)", async () => {
    const r = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: randomUUID(), quantity: 1 }] },
    });
    assert.equal(r.status, 422);
    assert.equal(r.json.code, "E_VALIDATION");
    assert.match(r.json.error, /not found or not available/);
  });

  it("a non-uuid id is the SAME indistinguishable 422 — not a DB error 500", async () => {
    const r = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: "abc", quantity: 1 }] },
    });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.match(r.json.error, /not found or not available/);
  });

  it("a hidden collection (zero public fields) is 404 like the read surface — not a name oracle", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "internal_notes",
      fields: [{ name: "memo", label: "M", type: "text", required: true }], // no publicRead
    });
    const hidden = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "internal_notes", items: [{ id: randomUUID(), quantity: 1 }] },
    });
    const absent = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "does_not_exist", items: [{ id: randomUUID(), quantity: 1 }] },
    });
    assert.equal(hidden.status, 404, JSON.stringify(hidden.json));
    assert.equal(absent.status, 404);
    assert.equal(hidden.json.error, absent.json.error, "hidden and absent must be indistinguishable");
  });

  it("a 2xx from Stripe with an unreadable body is 502 E_UPSTREAM — never a 201 with url 'undefined'", async () => {
    const trap = (await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { title: "Trap", price_id: "price_badbody" },
    })).value.id;
    const r = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: trap, quantity: 1 }] },
    });
    assert.equal(r.status, 502, JSON.stringify(r.json));
    assert.equal(r.json.code, "E_UPSTREAM");
  });

  it("an id from another collection is scoped out (same indistinguishable 422)", async () => {
    // Define a second collection + entry; its id must not be sellable via products.
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "body", label: "B", type: "text", required: true, publicRead: true }],
    });
    const noteId = (await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { body: "x" } })).value.id;
    const r = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: noteId, quantity: 1 }] },
    });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /not found or not available/);
  });

  it("an entry whose priceField is not a Stripe Price id is rejected", async () => {
    const r = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: badPrice, quantity: 1 }] },
    });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /is not a Stripe Price id/);
  });

  it("a URL override on a foreign origin is rejected; a same-origin path is honored", async () => {
    const foreign = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: aaa, quantity: 1 }], successUrl: "https://evil.example.com/ok" },
    });
    assert.equal(foreign.status, 422);
    assert.match(foreign.json.error, /same the configured URL's origin|share the configured URL's origin/);

    mock.reset();
    const ok = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: aaa, quantity: 1 }], successUrl: "https://shop.example.com/thanks?ref=1" },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    const sent = mock.requests.find((q) => q.path === "/v1/checkout/sessions");
    assert.equal(sent.form.success_url, "https://shop.example.com/thanks?ref=1");
  });

  it("a non-sellable collection (no checkout config) is 422", async () => {
    const r = await delivery(p.deliveryToken, "/checkout", {
      method: "POST",
      body: { collection: "notes", items: [{ id: aaa, quantity: 1 }] },
    });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /not sellable/);
  });

  it("checkout without a usable connector secret is 503", async () => {
    // Its own project + cache key: connector row present (so define passes) but
    // no secret_enc, so connectorSecret returns null at checkout time.
    const noSk = await createEphemeralProject("checkout-nosk");
    try {
      await sql`INSERT INTO project_connectors (project_id, type, config, status)
        VALUES (${noSk.id}, 'stripe', ${JSON.stringify({ publishableKey: "pk_test_x" })}::jsonb, 'connected')`;
      const def = await mcp(noSk.mcpToken, "define_collection", { name: "products", fields: productFields, checkout });
      assert.ok(def.ok, def.errorText);
      const id = (await mcp(noSk.mcpToken, "create_entry", { collection: "products", data: { title: "A", price_id: "price_z" } })).value.id;
      const r = await delivery(noSk.deliveryToken, "/checkout", {
        method: "POST",
        body: { collection: "products", items: [{ id, quantity: 1 }] },
      });
      assert.equal(r.status, 503, JSON.stringify(r.json));
      // Machine code must say "operator connects it" — NOT E_INTERNAL "retry".
      assert.equal(r.json.code, "E_CONNECTOR_REQUIRED");
    } finally {
      await noSk.destroy();
    }
  });

  it("requires a project token (401 without one)", async () => {
    const r = await delivery("agx_not_a_real_token", "/checkout", {
      method: "POST",
      body: { collection: "products", items: [{ id: aaa, quantity: 1 }] },
    });
    assert.equal(r.status, 401);
    assert.equal(r.json.code, "E_AUTH");
  });
});
