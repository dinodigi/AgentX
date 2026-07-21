import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  startWebhookReceiver,
  queryDeliveries,
  waitFor,
  mcp,
} from "./helpers.mjs";

describe("events: actions, emit, delivery log", () => {
  let p, receiver;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("events");
    receiver = await startWebhookReceiver();
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "signups",
      fields: [{ name: "email", label: "Email", type: "text", required: true }],
      events: { updated: [{ type: "webhook", url: receiver.url }] },
    });
    assert.ok(def.ok, def.errorText);
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  it("update fires the webhook and logs a success delivery", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "signups", data: { email: "a@b.c" } });
    await mcp(p.mcpToken, "update_entry", { collection: "signups", id: c.value.id, data: { email: "b@c.d" } });

    const hit = await waitFor(() => receiver.received.find((r) => r.event === "entry.updated"));
    assert.ok(hit, "receiver should get entry.updated");
    assert.equal(hit.collection, "signups");
    assert.equal(hit.entry.data.email, "b@c.d");

    const logged = await waitFor(async () => {
      const rows = await queryDeliveries(p.id);
      return rows.find((r) => r.event === "entry.updated" && r.status === "success");
    });
    assert.ok(logged, "webhook_deliveries should record success");
  });

  it("updated payloads carry previous + changedFields", async () => {
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "signups",
      data: { email: "old@snapshot.io" },
    });
    await mcp(p.mcpToken, "update_entry", {
      collection: "signups",
      id: c.value.id,
      data: { email: "new@snapshot.io" },
    });
    const hit = await waitFor(() =>
      receiver.received.find((r) => r.entry?.data?.email === "new@snapshot.io"),
    );
    assert.ok(hit, "receiver should get the update");
    assert.equal(hit.previous.data.email, "old@snapshot.io");
    assert.deepEqual(hit.changedFields, ["email"]);
  });

  it("when: conditional actions fire only on matching snapshots", async () => {
    const cond = await startWebhookReceiver();
    try {
      await mcp(p.mcpToken, "define_collection", {
        name: "orders",
        fields: [
          { name: "item", label: "Item", type: "text" },
          { name: "status", label: "Status", type: "enum", options: ["pending", "confirmed"] },
        ],
        events: {
          updated: [
            { type: "webhook", url: cond.url, when: [{ field: "status", op: "eq", value: "confirmed" }] },
          ],
        },
      });
      const c = await mcp(p.mcpToken, "create_entry", {
        collection: "orders",
        data: { item: "kayak", status: "pending" },
      });
      // Non-matching update: still pending — must NOT fire.
      await mcp(p.mcpToken, "update_entry", {
        collection: "orders",
        id: c.value.id,
        data: { item: "kayak deluxe" },
      });
      // Matching update — must fire exactly once.
      await mcp(p.mcpToken, "update_entry", {
        collection: "orders",
        id: c.value.id,
        data: { status: "confirmed" },
      });
      const hit = await waitFor(() => cond.received.find((r) => r.event === "entry.updated"));
      assert.ok(hit, "confirmed update should fire");
      assert.equal(hit.entry.data.status, "confirmed");
      assert.equal(cond.received.length, 1, "pending update must not have fired");
    } finally {
      await cond.close();
    }
  });

  it("when clauses are validated at define time", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "badwhen",
      fields: [{ name: "x", label: "X", type: "text" }],
      events: {
        created: [{ type: "webhook", url: "https://example.com/h", when: [{ field: "nope", op: "eq", value: 1 }] }],
      },
    });
    assert.ok(!r.ok && /valid fields:/.test(r.errorText), r.errorText);
  });

  it("disabled actions stay in the schema but never fire", async () => {
    const off = await startWebhookReceiver();
    const on = await startWebhookReceiver();
    try {
      await mcp(p.mcpToken, "define_collection", {
        name: "paused",
        fields: [{ name: "x", label: "X", type: "text" }],
        events: {
          created: [
            { type: "webhook", url: off.url, disabled: true },
            { type: "webhook", url: on.url },
          ],
        },
      });
      await mcp(p.mcpToken, "create_entry", { collection: "paused", data: { x: "1" } });
      const hit = await waitFor(() => on.received.find((r) => r.event === "entry.created"));
      assert.ok(hit, "enabled action should fire");
      assert.equal(off.received.length, 0, "disabled action must not fire");

      const desc = await mcp(p.mcpToken, "describe_collection", { name: "paused" });
      assert.equal(desc.value.events.created[0].disabled, true, "flag survives in the schema");
    } finally {
      await off.close();
      await on.close();
    }
  });

  it("refire_delivery replays a failed webhook as a new log row", async () => {
    const flaky = await startWebhookReceiver();
    try {
      flaky.setStatus(500);
      await mcp(p.mcpToken, "define_collection", {
        name: "flaky",
        fields: [{ name: "x", label: "X", type: "text" }],
        events: { created: [{ type: "webhook", url: flaky.url }] },
      });
      await mcp(p.mcpToken, "create_entry", { collection: "flaky", data: { x: "1" } });

      const failed = await waitFor(async () => {
        const r = await mcp(p.mcpToken, "get_deliveries", { collection: "flaky", status: "failed" });
        return r.ok && r.value.deliveries[0] ? r.value.deliveries[0] : null;
      }, { timeoutMs: 20000 });
      assert.ok(failed, "the 500-ing receiver should produce a failed delivery");

      flaky.setStatus(200);
      const refire = await mcp(p.mcpToken, "refire_delivery", { deliveryId: failed.id });
      assert.ok(refire.ok, refire.errorText);
      assert.equal(refire.value.status, "success");

      const successRow = await waitFor(async () => {
        const r = await mcp(p.mcpToken, "get_deliveries", { collection: "flaky", status: "success" });
        return r.ok && r.value.deliveries[0] ? r.value.deliveries[0] : null;
      });
      assert.ok(successRow, "the replay must land as a NEW success row");
      assert.equal(successRow.payload.entry.data.x, "1", "replay reuses the stored payload");

      const bogus = await mcp(p.mcpToken, "refire_delivery", {
        deliveryId: "00000000-0000-0000-0000-000000000000",
      });
      assert.ok(!bogus.ok && /\[E_NOT_FOUND\]/.test(bogus.errorText), bogus.errorText);
    } finally {
      await flaky.close();
    }
  });

  // The gate is on the email CATEGORY, not one provider (connector provider
  // registry): any connected email provider satisfies it, so the refusal is
  // provider-neutral and names the options rather than demanding Resend.
  it("email actions are define-time gated on having an email provider", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [{ name: "email", label: "Email", type: "text" }],
      events: { created: [{ type: "email", to: "x@y.z", subject: "New" }] },
    });
    assert.ok(!r.ok, "must refuse without an email provider");
    assert.match(r.errorText, /an email provider/i, r.errorText);
  });

  it("invalid webhook urls are rejected at define time", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      fields: [{ name: "x", label: "X", type: "text" }],
      events: { created: [{ type: "webhook", url: "ftp://nope" }] },
    });
    assert.ok(!r.ok && /http/.test(r.errorText));
  });
});
