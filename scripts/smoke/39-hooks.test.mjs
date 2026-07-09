import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import {
  ensureServer,
  createEphemeralProject,
  startHookReceiver,
  mcp,
  delivery,
  waitFor,
  queryDeliveries,
} from "./helpers.mjs";

// I1a: signed before-create hooks. A hook POST is HMAC-signed with the project's
// webhook signing secret and gates the write: {ok:true} allows, {ok:false,error}
// rejects (E_HOOK_REJECTED), unreachable/malformed → fail-closed E_HOOK_FAILED
// (onError:'reject') or fail-open (onError:'allow').
const sql = neon(process.env.DATABASE_URL);

const hook = (url, extra = {}) => ({ beforeCreate: { url, mode: "validate", timeoutMs: 700, ...extra } });

describe("before-create hooks (I1a)", () => {
  let p, rcv;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("hooks");
    rcv = await startHookReceiver();
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "amount", label: "A", type: "number", publicRead: true },
      ],
      publicWrite: true,
      hooks: hook(rcv.url),
    });
    assert.ok(def.ok, def.errorText);
  });
  after(async () => {
    await rcv.close();
    await p.destroy();
  });

  it("approves: create succeeds and the hook got a correctly-signed envelope", async () => {
    rcv.approve();
    rcv.received.length = 0;
    const r = await mcp(p.mcpToken, "create_entry", { collection: "leads", data: { title: "Ada", amount: 5 } });
    assert.ok(r.ok, r.errorText);
    assert.equal(rcv.received.length, 1, "hook consulted exactly once");
    const got = rcv.received[0];
    assert.equal(got.headers["x-agentx-hook"], "1");
    // Signature: t=<unix>,v1=HMAC_SHA256(secret, `${t}.${rawBody}`).
    const sig = got.headers["x-agentx-signature"];
    const t = /t=(\d+)/.exec(sig)?.[1];
    const v1 = /v1=([0-9a-f]+)/.exec(sig)?.[1];
    const expected = createHmac("sha256", p.signingSecret).update(`${t}.${got.body}`).digest("hex");
    assert.equal(v1, expected, "hook request is signed with the project secret");
    assert.equal(got.json.event, "entry.before_create");
    assert.equal(got.json.collection, "leads");
    assert.equal(got.json.candidate.data.title, "Ada");
  });

  it("rejects: create_entry fails E_HOOK_REJECTED carrying the hook's reason", async () => {
    rcv.reject("title is on the blocklist");
    const r = await mcp(p.mcpToken, "create_entry", { collection: "leads", data: { title: "Bad" } });
    assert.ok(!r.ok, "must fail");
    assert.match(r.errorText, /E_HOOK_REJECTED/);
    assert.match(r.errorText, /blocklist/);
  });

  it("rejects via the delivery POST → 422 E_HOOK_REJECTED (distinct from E_VALIDATION)", async () => {
    rcv.reject("no");
    const res = await delivery(p.deliveryToken, "/leads", { method: "POST", body: { title: "X" } });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, "E_HOOK_REJECTED");
  });

  it("unreachable (timeout) + onError:reject (default) → E_HOOK_FAILED, write blocked", async () => {
    rcv.hang();
    const r = await mcp(p.mcpToken, "create_entry", { collection: "leads", data: { title: "Slow" } });
    assert.ok(!r.ok && /E_HOOK_FAILED/.test(r.errorText), r.errorText);
    rcv.approve(); // release for later tests
  });

  it("malformed hook response + reject → E_HOOK_FAILED", async () => {
    rcv.malformed();
    const res = await delivery(p.deliveryToken, "/leads", { method: "POST", body: { title: "M" } });
    assert.equal(res.status, 502);
    assert.equal(res.json.code, "E_HOOK_FAILED");
    rcv.approve();
  });

  it("onError:'allow' fails OPEN on an outage — the write proceeds, logged as failed", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "leads_open",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
      hooks: hook(rcv.url, { onError: "allow" }),
    });
    assert.ok(def.ok, def.errorText);
    rcv.hang();
    const r = await mcp(p.mcpToken, "create_entry", { collection: "leads_open", data: { title: "Open" } });
    assert.ok(r.ok, "fail-open must let the write through: " + r.errorText);
    // A failed consult is still logged.
    const failed = await waitFor(async () =>
      (await queryDeliveries(p.id)).find((d) => d.event === "hook.before_create" && d.status === "failed"),
    );
    assert.ok(failed, "the failed consult was logged");
    rcv.approve();
  });

  it("`when` gates the consult — a non-matching create skips the hook entirely", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "leads_when",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "vip", label: "V", type: "boolean", publicRead: true },
      ],
      hooks: hook(rcv.url, { when: [{ field: "vip", op: "eq", value: true }] }),
    });
    assert.ok(def.ok, def.errorText);
    rcv.reject("only vips are checked"); // would block IF consulted
    // vip:false → hook NOT consulted → succeeds despite the reject setting.
    const skip = await mcp(p.mcpToken, "create_entry", { collection: "leads_when", data: { title: "Plain", vip: false } });
    assert.ok(skip.ok, "non-matching write must skip the hook: " + skip.errorText);
    // vip:true → hook consulted → rejected.
    const hit = await mcp(p.mcpToken, "create_entry", { collection: "leads_when", data: { title: "VIP", vip: true } });
    assert.ok(!hit.ok && /E_HOOK_REJECTED/.test(hit.errorText), hit.errorText);
    rcv.approve();
  });

  it("bulk_create_entries is refused on a hooked collection", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "leads",
      entries: [{ title: "a" }, { title: "b" }],
    });
    assert.ok(!r.ok && /beforeCreate hook|create_entry per item/.test(r.errorText), r.errorText);
  });

  it("transact creates ARE gated by the hook (no bypass) — reject aborts, approve commits", async () => {
    // Reject: the whole batch must fail with E_HOOK_REJECTED and write nothing.
    rcv.reject("transact must not bypass me");
    rcv.received.length = 0;
    const blocked = await mcp(p.mcpToken, "transact", {
      ops: [{ op: "create", collection: "leads", data: { title: "ViaTransact" } }],
    });
    assert.ok(!blocked.ok && /E_HOOK_REJECTED/.test(blocked.errorText), blocked.errorText);
    assert.ok(rcv.received.length >= 1, "the hook WAS consulted on the transact create");

    // Approve: the same batch now commits.
    rcv.approve();
    const ok = await mcp(p.mcpToken, "transact", {
      ops: [{ op: "create", collection: "leads", data: { title: "ViaTransactOK" } }],
    });
    assert.ok(ok.ok, ok.errorText);
  });

  it("get_deliveries surfaces hook.before_create rows; a hook row cannot be refired", async () => {
    rcv.approve();
    await mcp(p.mcpToken, "create_entry", { collection: "leads", data: { title: "Logged" } });
    const d = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "get_deliveries", { collection: "leads" });
      return r.ok && r.value.deliveries.find((row) => row.event === "hook.before_create");
    });
    assert.ok(d, "hook consult logged");
    const refire = await mcp(p.mcpToken, "refire_delivery", { deliveryId: d.id });
    assert.ok(!refire.ok && /cannot be replayed|re-attempt the write/.test(refire.errorText), refire.errorText);
  });

  it("define-time: transform mode and beforeUpdate are rejected (land in I1b)", async () => {
    const transform = await mcp(p.mcpToken, "define_collection", {
      name: "leads_t",
      fields: [{ name: "title", label: "T", type: "text", required: true }],
      hooks: { beforeCreate: { url: rcv.url, mode: "transform" } },
    });
    assert.ok(!transform.ok && /transform mode lands|I1b/.test(transform.errorText), transform.errorText);
    const bu = await mcp(p.mcpToken, "define_collection", {
      name: "leads_u",
      fields: [{ name: "title", label: "T", type: "text", required: true }],
      hooks: { beforeUpdate: { url: rcv.url, mode: "validate" } },
    });
    assert.ok(!bu.ok && /beforeUpdate lands|I1b/.test(bu.errorText), bu.errorText);
  });

  it("define-time: a hook needs the project's webhook signing secret", async () => {
    const noSecret = await createEphemeralProject("hooks-nosecret");
    try {
      await sql`UPDATE projects SET webhook_signing_secret = NULL WHERE id = ${noSecret.id}`;
      const r = await mcp(noSecret.mcpToken, "define_collection", {
        name: "leads",
        fields: [{ name: "title", label: "T", type: "text", required: true }],
        hooks: hook(rcv.url),
      });
      assert.ok(!r.ok && /signing secret/.test(r.errorText), r.errorText);
    } finally {
      await noSecret.destroy();
    }
  });
});
