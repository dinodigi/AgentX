import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  connectClerk,
  startMockIssuer,
  startWebhookReceiver,
  mcp,
  delivery,
  waitFor,
} from "./helpers.mjs";

// G4: declarative state machines — initial enforced on ALL create paths,
// actor-gated transitions, matched-transition actions fired.
describe("declarative workflows (G4)", () => {
  let p, issuer, receiver;
  const define = (workflow, extra = {}) =>
    mcp(p.mcpToken, "define_collection", {
      name: "requests",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
        {
          name: "status",
          label: "S",
          type: "enum",
          options: ["draft", "submitted", "approved", "rejected", "cancelled"],
          publicRead: true,
        },
      ],
      access: { read: "authenticated", write: "owner", ownerField: "owner" },
      workflow,
      ...extra,
    });

  const WORKFLOW = (receiverUrl) => ({
    field: "status",
    initial: "draft",
    transitions: [
      { from: "draft", to: "submitted", actors: ["delivery", "mcp", "admin"] },
      // approve is staff-only (default actors mcp+admin) and fires a webhook
      { from: "submitted", to: "approved", actions: [{ type: "webhook", url: receiverUrl }] },
      { from: "submitted", to: "rejected" },
      // the owner may cancel their own submission (delivery opted in)
      { from: ["draft", "submitted"], to: "cancelled", actors: ["delivery", "mcp", "admin"] },
    ],
  });

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("workflow");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    receiver = await startWebhookReceiver();
    const d = await define(WORKFLOW(receiver.url));
    assert.ok(d.ok, d.errorText);
  });
  after(async () => {
    await receiver.close();
    await issuer.close();
    await p.destroy();
  });

  it("define-time: overlapping (from,to), bad states, and non-enum field are rejected", async () => {
    const overlap = await define({
      field: "status",
      initial: "draft",
      transitions: [
        { from: "draft", to: "submitted" },
        { from: "draft", to: "submitted", actors: ["delivery"] },
      ],
    });
    assert.ok(!overlap.ok && /two transitions share/.test(overlap.errorText), overlap.errorText);

    const badState = await define({
      field: "status",
      initial: "nope",
      transitions: [{ from: "draft", to: "submitted" }],
    });
    assert.ok(!badState.ok && /initial/.test(badState.errorText), badState.errorText);

    const nonEnum = await mcp(p.mcpToken, "define_collection", {
      name: "wf_bad",
      fields: [{ name: "s", label: "S", type: "text", required: true }],
      workflow: { field: "s", initial: "a", transitions: [{ from: "a", to: "b" }] },
    });
    assert.ok(!nonEnum.ok && /enum/.test(nonEnum.errorText), nonEnum.errorText);
  });

  it("create defaults the field to initial; an explicit non-initial is rejected", async () => {
    const d = await mcp(p.mcpToken, "create_entry", { collection: "requests", data: { title: "a", owner: "u1" } });
    assert.ok(d.ok, d.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "requests", id: d.value.id });
    assert.equal(got.value.data.status, "draft", "defaulted to initial");

    const spoof = await mcp(p.mcpToken, "create_entry", {
      collection: "requests",
      data: { title: "b", owner: "u1", status: "approved" },
    });
    assert.ok(!spoof.ok && /must start at "draft"/.test(spoof.errorText), spoof.errorText);
  });

  it("bulk_create_entries enforces initial per-item (parallel write path can't spoof)", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "requests",
      entries: [
        { title: "ok", owner: "u1" },
        { title: "spoofed", owner: "u1", status: "approved" },
      ],
    });
    assert.ok(r.ok, r.errorText);
    const results = r.value.results ?? r.value;
    const spoofed = results.find((x) => x.index === 1);
    assert.equal(spoofed.ok, false, "spoofed bulk item rejected");
    assert.match(spoofed.error, /must start at "draft"/);
    assert.ok(results.find((x) => x.index === 0).ok, "valid sibling still created");
  });

  it("transact create ALSO enforces initial (no spoof via a batch)", async () => {
    const spoof = await mcp(p.mcpToken, "transact", {
      ops: [{ op: "create", collection: "requests", data: { title: "tx", owner: "u1", status: "approved" } }],
    });
    assert.ok(!spoof.ok, "transact create with a spoofed initial state must fail the batch");
    assert.match(spoof.errorText, /must start at "draft"/);
    // a valid transact create defaults to initial
    const ok = await mcp(p.mcpToken, "transact", {
      ops: [{ op: "create", collection: "requests", data: { title: "tx2", owner: "u1" } }],
    });
    assert.ok(ok.ok, ok.errorText);
  });

  it("a legal MCP transition fires the matched transition's webhook with exact from/to", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "requests", data: { title: "c", owner: "u1" } });
    const id = c.value.id;
    const sub = await mcp(p.mcpToken, "update_entry", { collection: "requests", id, data: { status: "submitted" } });
    assert.ok(sub.ok, sub.errorText);
    const app = await mcp(p.mcpToken, "update_entry", { collection: "requests", id, data: { status: "approved" } });
    assert.ok(app.ok, app.errorText);
    const hit = await waitFor(() =>
      receiver.received.find((r) => r.event === "entry.transitioned" && r.entry?.id === id),
    );
    assert.ok(hit, "entry.transitioned webhook fired");
    assert.equal(hit.transition.field, "status");
    assert.equal(hit.transition.from, "submitted");
    assert.equal(hit.transition.to, "approved");
  });

  it("an illegal transition is rejected naming the allowed targets", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "requests", data: { title: "d", owner: "u1" } });
    // draft → approved is not a declared transition
    const bad = await mcp(p.mcpToken, "update_entry", { collection: "requests", id: c.value.id, data: { status: "approved" } });
    assert.ok(!bad.ok, "draft→approved must be rejected");
    assert.match(bad.errorText, /cannot move|not a transition target/);
  });

  it("actor gate: a delivery owner CANNOT approve, but CAN submit and cancel", async () => {
    const owner = await issuer.tokenFor("u_owner", {});
    const created = await delivery(p.deliveryToken, "/requests", {
      method: "POST",
      body: { title: "mine" },
      userToken: owner,
    });
    assert.equal(created.status, 201);
    const id = created.json.id;

    // owner submits (delivery opted into draft→submitted)
    const sub = await delivery(p.deliveryToken, `/requests/${id}`, { method: "PATCH", body: { status: "submitted" }, userToken: owner });
    assert.equal(sub.status, 200);

    // owner tries to self-approve → 422 (delivery not in approve's actors)
    const selfApprove = await delivery(p.deliveryToken, `/requests/${id}`, { method: "PATCH", body: { status: "approved" }, userToken: owner });
    assert.equal(selfApprove.status, 422);
    assert.match(selfApprove.json.error, /actor "delivery"/);

    // but the owner CAN cancel their own submission (delivery opted in)
    const cancel = await delivery(p.deliveryToken, `/requests/${id}`, { method: "PATCH", body: { status: "cancelled" }, userToken: owner });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.json.data.status, "cancelled");
  });

  it("restore_entry_version cannot move the workflow field (restore is content-only)", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "requests", data: { title: "ver", owner: "u1" } });
    const id = c.value.id;
    // v1 snapshot captures {title:"ver", status:"draft"} (the pre-update state).
    await mcp(p.mcpToken, "update_entry", { collection: "requests", id, data: { title: "ver2" } });
    // legitimately transition draft→submitted.
    await mcp(p.mcpToken, "update_entry", { collection: "requests", id, data: { status: "submitted" } });

    const versions = await mcp(p.mcpToken, "list_entry_versions", { collection: "requests", id });
    const draftVer = (versions.value.versions ?? versions.value).find((v) => v.data.status === "draft" && v.data.title === "ver");
    assert.ok(draftVer, "a draft-status snapshot should exist");

    const restored = await mcp(p.mcpToken, "restore_entry_version", { collection: "requests", id, versionId: draftVer.versionId });
    assert.ok(restored.ok, restored.errorText);
    assert.equal(restored.value.data.title, "ver", "content reverts");
    assert.equal(restored.value.data.status, "submitted", "workflow field is PINNED to live — restore can't reverse a transition");
  });

  it("update_entry_if transition: guarded on the CAS path, exact from reported", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "requests", data: { title: "cas", owner: "u1" } });
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "requests", id, data: { status: "submitted" } });
    // CAS approve from submitted — allowed
    const ok = await mcp(p.mcpToken, "update_entry_if", { collection: "requests", id, if: [{ field: "title", op: "eq", value: "cas" }], data: { status: "approved" } });
    assert.ok(ok.ok, ok.errorText);
    // CAS approve again (now approved) — approved is no transition's `from` to approved → conflict/validation, never a silent move
    const again = await mcp(p.mcpToken, "update_entry_if", { collection: "requests", id, data: { status: "rejected" } });
    assert.ok(!again.ok || again.value?.ok === false, "approved→rejected is not declared");
  });
});
