import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import {
  ensureServer,
  createEphemeralProject,
  connectStripe,
  mcp,
  delivery,
  startWebhookReceiver,
  startHookReceiver,
  queryDeliveries,
  waitFor,
  BASE,
} from "./helpers.mjs";
import { startStripeMock } from "./stripe-mock.mjs";

// K4: paid Checkout Sessions become order-entry writes. The /v1/checkout POST
// hits the in-process Stripe mock; the lifecycle events are self-signed with
// the project's whsec and replayed at the webhook.
const WHSEC = "whsec_orders_secret";

const sign = (body, secret = WHSEC) => {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
};
const evt = (type, object) => JSON.stringify({ id: "evt_" + randomUUID(), type, data: { object } });
const postHook = (projectId, body, secret) =>
  fetch(`${BASE}/api/stripe/webhook/${projectId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": sign(body, secret) },
    body,
  });

const orderFields = [
  { name: "status", label: "Status", type: "enum", options: ["pending", "paid", "expired"], required: true },
  { name: "session_id", label: "Session", type: "text" },
  { name: "total", label: "Total", type: "number" },
  { name: "customer_email", label: "Email", type: "text" },
  { name: "items", label: "Items", type: "text" },
];
const productFields = [
  { name: "title", label: "T", type: "text", required: true, publicRead: true },
  { name: "price_id", label: "Price", type: "text", publicRead: true },
];
const ordersMap = {
  collection: "orders",
  fields: { status: "status", sessionId: "session_id", total: "total", customerEmail: "customer_email", items: "items" },
};
const checkout = {
  priceField: "price_id",
  successUrl: "https://shop.example.com/ok",
  cancelUrl: "https://shop.example.com/no",
  orders: ordersMap,
};

/** Stand up a project with a fulfillment receiver, orders + products, connector. */
async function seedShop(label) {
  const receiver = await startWebhookReceiver();
  const p = await createEphemeralProject(label);
  await connectStripe(p.id, { whsec: WHSEC });
  const defOrders = await mcp(p.mcpToken, "define_collection", {
    name: "orders",
    fields: orderFields,
    // Fulfillment fires ONLY when payment actually clears (status → paid).
    events: { updated: [{ type: "webhook", url: receiver.url, when: [{ field: "status", op: "eq", value: "paid" }] }] },
  });
  assert.ok(defOrders.ok, defOrders.errorText);
  const defProducts = await mcp(p.mcpToken, "define_collection", { name: "products", fields: productFields, checkout });
  assert.ok(defProducts.ok, defProducts.errorText);
  const prod = await mcp(p.mcpToken, "create_entry", { collection: "products", data: { title: "Widget", price_id: "price_widget" } });
  return { p, receiver, productId: prod.value.id };
}

/** POST a cart and return the pending order id (read back from the mock request). */
async function checkoutOne(shop, mock) {
  mock.reset();
  const res = await delivery(shop.p.deliveryToken, "/checkout", {
    method: "POST",
    body: { collection: "products", items: [{ id: shop.productId, quantity: 2 }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const sent = mock.requests.find((q) => q.path === "/v1/checkout/sessions");
  const orderId = sent.form["metadata[orderEntryId]"];
  return { orderId, clientRef: sent.form.client_reference_id, sessionId: res.json.sessionId };
}

describe("stripe order lifecycle (K4)", () => {
  let mock;
  before(async () => {
    await ensureServer();
    mock = await startStripeMock();
  });
  after(async () => {
    await mock.close();
  });

  it("define-time: orders mapping requires the target + the pending/paid/expired states", async () => {
    const p = await createEphemeralProject("orders-validate");
    try {
      await connectStripe(p.id, { whsec: WHSEC });
      const bad = (extra) =>
        mcp(p.mcpToken, "define_collection", { name: "products", fields: productFields, checkout: { ...checkout, ...extra } });

      const noTarget = await bad({ orders: { ...ordersMap, collection: "nope" } });
      assert.ok(!noTarget.ok && /orders\.collection.*does not exist/.test(noTarget.errorText), noTarget.errorText);

      // orders exists but its status enum lacks the required options.
      await mcp(p.mcpToken, "define_collection", {
        name: "orders",
        fields: [{ name: "status", label: "S", type: "enum", options: ["open"], required: true }, { name: "session_id", label: "S", type: "text" }],
      });
      const badStates = await bad({ orders: ordersMap });
      assert.ok(!badStates.ok && /missing required option/.test(badStates.errorText), badStates.errorText);
    } finally {
      await p.destroy();
    }
  });

  it("checkout opens a pending order and sends its id as the correlation key (not projectId)", async () => {
    const shop = await seedShop("orders-checkout");
    try {
      const { orderId, clientRef } = await checkoutOne(shop, mock);
      assert.match(orderId, /^[0-9a-f-]{36}$/, "orderEntryId is the order entry uuid");
      assert.equal(clientRef, orderId, "client_reference_id mirrors the order id");
      const sent = mock.requests.find((q) => q.path === "/v1/checkout/sessions");
      assert.ok(!("metadata[projectId]" in sent.form), "projectId never travels through Stripe");

      const order = await mcp(shop.p.mcpToken, "get_entry", { collection: "orders", id: orderId });
      assert.equal(order.value.data.status, "pending");
      assert.equal(order.value.data.items, JSON.stringify([{ id: shop.productId, quantity: 2 }]));
    } finally {
      await shop.receiver.close();
      await shop.p.destroy();
    }
  });

  it("a paid session flips pending→paid, stamps details, and fires fulfillment exactly once", async () => {
    const shop = await seedShop("orders-paid");
    try {
      const { orderId } = await checkoutOne(shop, mock);
      const paid = evt("checkout.session.completed", {
        id: "cs_test_paid",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        customer_details: { email: "buyer@example.com" },
        metadata: { collection: "products", orderEntryId: orderId },
      });
      const res = await postHook(shop.p.id, paid);
      assert.equal(res.status, 200, await res.clone().text());

      const order = await mcp(shop.p.mcpToken, "get_entry", { collection: "orders", id: orderId });
      assert.equal(order.value.data.status, "paid");
      assert.equal(order.value.data.session_id, "cs_test_paid");
      assert.equal(order.value.data.total, 25, "2500 minor units / 100 = 25.00");
      assert.equal(order.value.data.customer_email, "buyer@example.com");

      // Fulfillment webhook fired on the paid transition.
      const fired = await waitFor(() => shop.receiver.received.find((r) => r.event === "entry.updated"));
      assert.ok(fired, "fulfillment webhook received the entry.updated event");
      // The inbound event was logged as a stripe: delivery row.
      const rows = await queryDeliveries(shop.p.id);
      assert.ok(rows.some((r) => r.url === "stripe:checkout.session.completed" && r.status === "success"));

      // Replay the SAME event: CAS guard keeps it at exactly one paid flip.
      const before = shop.receiver.received.length;
      const again = await postHook(shop.p.id, paid);
      assert.equal(again.status, 200);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(shop.receiver.received.length, before, "no second fulfillment on replay (idempotent)");
    } finally {
      await shop.receiver.close();
      await shop.p.destroy();
    }
  });

  it("async methods: completed(unpaid) stays pending; async_payment_succeeded settles it", async () => {
    const shop = await seedShop("orders-async");
    try {
      const { orderId } = await checkoutOne(shop, mock);
      const base = { id: "cs_async", metadata: { collection: "products", orderEntryId: orderId } };

      const pendingRes = await postHook(shop.p.id, evt("checkout.session.completed", { ...base, payment_status: "unpaid" }));
      assert.equal(pendingRes.status, 200);
      let order = await mcp(shop.p.mcpToken, "get_entry", { collection: "orders", id: orderId });
      assert.equal(order.value.data.status, "pending", "unpaid async does not flip");

      const settled = await postHook(
        shop.p.id,
        evt("checkout.session.async_payment_succeeded", { ...base, payment_status: "paid", amount_total: 900, currency: "usd" }),
      );
      assert.equal(settled.status, 200);
      order = await mcp(shop.p.mcpToken, "get_entry", { collection: "orders", id: orderId });
      assert.equal(order.value.data.status, "paid");
      assert.equal(order.value.data.total, 9);
    } finally {
      await shop.receiver.close();
      await shop.p.destroy();
    }
  });

  it("expiry and async failure flip pending→expired", async () => {
    const shop = await seedShop("orders-expired");
    try {
      const { orderId } = await checkoutOne(shop, mock);
      const res = await postHook(
        shop.p.id,
        evt("checkout.session.expired", { id: "cs_exp", metadata: { collection: "products", orderEntryId: orderId } }),
      );
      assert.equal(res.status, 200);
      const order = await mcp(shop.p.mcpToken, "get_entry", { collection: "orders", id: orderId });
      assert.equal(order.value.data.status, "expired");
    } finally {
      await shop.receiver.close();
      await shop.p.destroy();
    }
  });

  it("cross-tenant: a signed event whose metadata points at ANOTHER project's order is a 200 no-op", async () => {
    const [a, b] = [await seedShop("orders-tenant-a"), await seedShop("orders-tenant-b")];
    try {
      const { orderId: bOrder } = await checkoutOne(b, mock);
      // Signed with A's whsec, delivered to A's URL, but metadata references B's order.
      const res = await postHook(
        a.p.id,
        evt("checkout.session.completed", {
          id: "cs_evil",
          payment_status: "paid",
          metadata: { collection: "products", orderEntryId: bOrder },
        }),
      );
      assert.equal(res.status, 200, await res.clone().text());
      // B's order is untouched — the flip's WHERE is scoped to A's orders collection.
      const bo = await mcp(b.p.mcpToken, "get_entry", { collection: "orders", id: bOrder });
      assert.equal(bo.value.data.status, "pending", "another tenant's order can never be flipped cross-project");
    } finally {
      await a.receiver.close(); await a.p.destroy();
      await b.receiver.close(); await b.p.destroy();
    }
  });

  it("a foreign checkout with no order metadata is acknowledged 200, unlogged", async () => {
    const shop = await seedShop("orders-foreign");
    try {
      const res = await postHook(
        shop.p.id,
        evt("checkout.session.completed", { id: "cs_foreign", payment_status: "paid", metadata: {} }),
      );
      assert.equal(res.status, 200);
      const rows = await queryDeliveries(shop.p.id);
      assert.equal(rows.length, 0, "foreign checkouts don't flood the delivery log");
    } finally {
      await shop.receiver.close();
      await shop.p.destroy();
    }
  });

  // ---- Review fixes ----

  it("editing a paid order does NOT re-fire fulfillment (fires on the transition, not the state)", async () => {
    const shop = await seedShop("orders-refire");
    try {
      const { orderId } = await checkoutOne(shop, mock);
      await postHook(
        shop.p.id,
        evt("checkout.session.completed", { id: "cs_r", payment_status: "paid", metadata: { collection: "products", orderEntryId: orderId } }),
      );
      await waitFor(() => shop.receiver.received.find((r) => r.event === "entry.updated"));
      const before = shop.receiver.received.length;
      // A later unrelated edit to the already-PAID order (status stays paid).
      await mcp(shop.p.mcpToken, "update_entry", { collection: "orders", id: orderId, data: { customer_email: "fixed@example.com" } });
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(shop.receiver.received.length, before, "no duplicate fulfillment on a paid→paid edit");
    } finally {
      await shop.receiver.close();
      await shop.p.destroy();
    }
  });

  it("define-time rejects orders configs the flip/pending-write can't satisfy", async () => {
    const p = await createEphemeralProject("orders-harden");
    try {
      await connectStripe(p.id, { whsec: WHSEC });
      const defOrders = (fields) => mcp(p.mcpToken, "define_collection", { name: "orders", fields });
      const mapProducts = () => mcp(p.mcpToken, "define_collection", { name: "products", fields: productFields, checkout });
      const swap = (name, patch) => [...orderFields.filter((f) => f.name !== name), { ...orderFields.find((f) => f.name === name), ...patch }];

      // A bounded/integer total would reject a real $24.99 order at flip time.
      await defOrders(swap("total", { integer: true }));
      let r = await mapProducts();
      assert.ok(!r.ok && /total.*must not be integer|integer\/min\/max/.test(r.errorText), r.errorText);

      // A unique customer_email would collide on a repeat buyer's second order.
      await defOrders(swap("customer_email", { unique: true }));
      r = await mapProducts();
      assert.ok(!r.ok && /customer_email.*must not be unique/.test(r.errorText), r.errorText);

      // A required unmapped field can't be filled by the pre-payment pending write.
      await defOrders([...orderFields, { name: "note", label: "N", type: "text", required: true }]);
      r = await mapProducts();
      assert.ok(!r.ok && /note.*is required|required.*pending order/.test(r.errorText), r.errorText);
    } finally {
      await p.destroy();
    }
  });

  it("narrowing the orders status enum out from under a live mapping is rejected (invariant #8)", async () => {
    const shop = await seedShop("orders-narrow");
    try {
      const r = await mcp(shop.p.mcpToken, "define_collection", {
        name: "orders",
        fields: [
          { name: "status", label: "S", type: "enum", options: ["pending", "paid"], required: true }, // dropped 'expired'
          ...orderFields.filter((f) => f.name !== "status"),
        ],
      });
      assert.ok(!r.ok && /expired|missing required option/.test(r.errorText), r.errorText);
    } finally {
      await shop.receiver.close();
      await shop.p.destroy();
    }
  });

  it("a unique session_id does NOT break repeated checkouts (pending write leaves it NULL)", async () => {
    const p = await createEphemeralProject("orders-uniq-session");
    const receiver = await startWebhookReceiver();
    try {
      await connectStripe(p.id, { whsec: WHSEC });
      await mcp(p.mcpToken, "define_collection", {
        name: "orders",
        fields: [...orderFields.filter((f) => f.name !== "session_id"), { name: "session_id", label: "S", type: "text", unique: true }],
      });
      const def = await mcp(p.mcpToken, "define_collection", { name: "products", fields: productFields, checkout });
      assert.ok(def.ok, def.errorText);
      const prod = await mcp(p.mcpToken, "create_entry", { collection: "products", data: { title: "W", price_id: "price_w" } });
      const buy = () => delivery(p.deliveryToken, "/checkout", { method: "POST", body: { collection: "products", items: [{ id: prod.value.id, quantity: 1 }] } });
      const first = await buy();
      const second = await buy();
      assert.equal(first.status, 201, JSON.stringify(first.json));
      assert.equal(second.status, 201, JSON.stringify(second.json) + " — two pending orders must not collide on an empty session_id");
    } finally {
      await receiver.close();
      await p.destroy();
    }
  });

  it("a beforeCreate transform on the orders collection CANNOT stamp ownership on the pending order (review #B)", async () => {
    const p = await createEphemeralProject("orders-hook-owner");
    const hookRcv = await startHookReceiver();
    try {
      await connectStripe(p.id, { whsec: WHSEC });
      // Owner-scoped orders + a beforeCreate transform hook that injects an owner.
      // Checkout creates the order ANONYMOUSLY (identity:{user:null}), so the
      // re-stamp must STRIP the hook's owner — a hook can't forge ownership.
      await mcp(p.mcpToken, "define_collection", {
        name: "orders",
        fields: [...orderFields, { name: "owner", label: "O", type: "text" }],
        access: { read: "owner", write: "owner", ownerField: "owner" },
        hooks: { beforeCreate: { url: hookRcv.url, mode: "transform", timeoutMs: 700 } },
      });
      const def = await mcp(p.mcpToken, "define_collection", { name: "products", fields: productFields, checkout });
      assert.ok(def.ok, def.errorText);
      const prod = await mcp(p.mcpToken, "create_entry", { collection: "products", data: { title: "W", price_id: "price_w" } });
      hookRcv.transform({ status: "pending", owner: "user_attacker" });
      mock.reset();
      const res = await delivery(p.deliveryToken, "/checkout", { method: "POST", body: { collection: "products", items: [{ id: prod.value.id, quantity: 1 }] } });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      const sent = mock.requests.find((q) => q.path === "/v1/checkout/sessions");
      const order = await mcp(p.mcpToken, "get_entry", { collection: "orders", id: sent.form["metadata[orderEntryId]"] });
      assert.ok(!order.value.data.owner, "the transform's injected owner must be stripped: " + JSON.stringify(order.value.data));
    } finally {
      await hookRcv.close();
      await p.destroy();
    }
  });
});
