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

  it("email actions are define-time gated on the Resend connector", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [{ name: "email", label: "Email", type: "text" }],
      events: { created: [{ type: "email", to: "x@y.z", subject: "New" }] },
    });
    assert.ok(!r.ok && /Resend connector/.test(r.errorText));
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
