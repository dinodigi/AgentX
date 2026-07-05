import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  ensureServer,
  createEphemeralProject,
  startWebhookReceiver,
  queryAudit,
  tokenLastUsed,
  waitFor,
  mcp,
  delivery,
  BASE,
} from "./helpers.mjs";

describe("security: signatures, CORS, limits, audit, last-used", () => {
  let p, receiver, signatureHeader;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("security");
    receiver = await startWebhookReceiver();
    // Capture headers too for the signature assertion.
    receiver.headers = [];
    await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [{ name: "email", label: "Email", type: "text", required: true, publicRead: true }],
      events: { created: [{ type: "webhook", url: receiver.url }] },
    });
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  it("webhooks carry a valid HMAC signature over t.body", async () => {
    await mcp(p.mcpToken, "create_entry", { collection: "leads", data: { email: "sig@test.dev" } });
    const hit = await waitFor(() => receiver.received.find((r) => r.raw?.headers?.["x-agentx-signature"]));
    assert.ok(hit, "receiver should get a signed webhook");
    const sig = hit.raw.headers["x-agentx-signature"];
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    assert.ok(m, `signature header format: ${sig}`);
    const [, t, v1] = m;
    assert.ok(Math.abs(Date.now() / 1000 - Number(t)) < 300, "timestamp fresh");
    const expected = createHmac("sha256", p.signingSecret)
      .update(`${t}.${hit.raw.body}`)
      .digest("hex");
    assert.equal(v1, expected, "HMAC verifies against the project secret");
    signatureHeader = sig;
  });

  it("delivery API answers preflight and carries CORS headers", async () => {
    const opt = await fetch(`${BASE}/api/v1/leads`, { method: "OPTIONS" });
    assert.equal(opt.status, 204);
    assert.equal(opt.headers.get("access-control-allow-origin"), "*");
    assert.ok(opt.headers.get("access-control-allow-headers").includes("x-user-token"));

    const get = await delivery(p.deliveryToken, "/leads");
    assert.equal(get.status, 200);
    // raw fetch to read headers
    const res = await fetch(`${BASE}/api/v1/leads`, {
      headers: { authorization: `Bearer ${p.deliveryToken}` },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });

  it("uploads reject disallowed content types with the allowlist hint", async () => {
    const r = await mcp(p.mcpToken, "upload_asset", {
      filename: "evil.exe",
      contentType: "application/x-msdownload",
      dataBase64: Buffer.from("MZ").toString("base64"),
    });
    assert.ok(!r.ok && /not allowed — allowed:/.test(r.errorText));
  });

  it("uploads reject oversize files", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 65).toString("base64");
    const r = await mcp(p.mcpToken, "upload_asset", {
      filename: "big.txt",
      contentType: "text/plain",
      dataBase64: big,
    });
    assert.ok(!r.ok && /too large/.test(r.errorText), r.errorText?.slice(0, 80));
  });

  it("audit log records create/update/delete with mcp actor", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "leads", data: { email: "a@a.a" } });
    await mcp(p.mcpToken, "update_entry", { collection: "leads", id: c.value.id, data: { email: "b@b.b" } });
    await mcp(p.mcpToken, "delete_entry", { collection: "leads", id: c.value.id });

    const rows = await waitFor(async () => {
      const all = await queryAudit(p.id);
      const mine = all.filter((r) => r.entry_id === c.value.id);
      return mine.length === 3 ? mine : null;
    });
    assert.ok(rows, "three audit rows expected");
    assert.deepEqual(rows.map((r) => r.action), ["create", "update", "delete"]);
    assert.ok(rows.every((r) => r.actor.type === "mcp"));
    assert.deepEqual(rows[1].changed_fields, ["email"]);
  });

  it("token last-used is stamped after first use", async () => {
    const used = await waitFor(() => tokenLastUsed(p.mcpToken));
    assert.ok(used, "mcp token should have last_used_at set");
  });
});
