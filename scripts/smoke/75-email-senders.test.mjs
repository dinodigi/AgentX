import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, connectResend, mcp, delivery, deliveryLog } from "./helpers.mjs";

// v2 Track 2a: email sender knobs. from = APPROVED senders only (connector
// fromEmail, its verified domain, or approvedSenders) — never free-form;
// replyTo interpolates (the reply-to-submitter pattern); cc/bcc static.
// The send fails against Resend (fake key) but the RENDER is logged — the
// 59-email-html precedent — so we assert on the stored render.
describe("email: custom sender / replyTo / cc / bcc", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("email-senders");
    await connectResend(p.id, { fromEmail: "noreply@stallion.test" });
  });

  it("rejects a from OUTSIDE the approved set at define time", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad_inbox",
      publicWrite: true,
      fields: [{ name: "email", label: "E", type: "text", required: true }],
      events: {
        created: [{ type: "email", to: "team@stallion.test", subject: "x", from: "ceo@evil.test" }],
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not an approved sender/i, r.errorText);
  });

  it("rejects a malformed from", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad_inbox2",
      publicWrite: true,
      fields: [{ name: "email", label: "E", type: "text", required: true }],
      events: { created: [{ type: "email", to: "a@stallion.test", subject: "x", from: "not-an-email" }] },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not a valid email address/i);
  });

  it("same-domain from + interpolated replyTo + cc land in the rendered email", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "inbox",
      publicWrite: true,
      fields: [
        { name: "email", label: "E", type: "text", required: true },
        { name: "message", label: "M", type: "text", required: true },
      ],
      events: {
        created: [
          {
            type: "email",
            to: "team@stallion.test",
            subject: "New inquiry",
            from: "sales@stallion.test", // same domain as fromEmail → approved
            replyTo: "{{email}}", // reply-to-submitter
            cc: ["owner@stallion.test"],
            bcc: ["archive@stallion.test"],
          },
        ],
      },
    });
    assert.ok(def.ok, def.errorText);

    const post = await delivery(p.deliveryToken, "/inbox", {
      method: "POST",
      body: { email: "customer@example.com", message: "hello" },
    });
    assert.equal(post.status, 201, JSON.stringify(post.json));

    // The email fires post-response; poll the delivery log for the render.
    let row;
    for (let i = 0; i < 20 && !row; i++) {
      const rows = await deliveryLog(p.id);
      row = rows.find((r) => String(r.url).startsWith("email:"));
      if (!row) await new Promise((r2) => setTimeout(r2, 500));
    }
    assert.ok(row, "email delivery row must appear");
    const email = row.payload.email;
    assert.equal(email.from, "sales@stallion.test");
    assert.equal(email.replyTo, "customer@example.com", "replyTo interpolated to the submitter");
    assert.deepEqual(email.cc, ["owner@stallion.test"]);
    assert.deepEqual(email.bcc, ["archive@stallion.test"]);
  });

  it("plain actions without the new knobs are untouched", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "plain",
      publicWrite: true,
      fields: [{ name: "m", label: "M", type: "text", required: true }],
      events: { created: [{ type: "email", to: "team@stallion.test", subject: "hi" }] },
    });
    assert.ok(def.ok, def.errorText);
  });
});
