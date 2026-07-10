import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, startHookReceiver, mcp, waitFor, queryDeliveries } from "./helpers.mjs";

// I2: test_hook dry-runs a collection's hook against sample data WITHOUT writing.
// It DOES call the tenant endpoint (logged as hook.test).
describe("test_hook dry-run (I2)", () => {
  let p, rcv;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("test-hook");
    rcv = await startHookReceiver();
    await mcp(p.mcpToken, "define_collection", {
      name: "items",
      fields: [
        { name: "name", label: "N", type: "text", required: true, publicRead: true },
        { name: "slug", label: "S", type: "text", publicRead: true },
      ],
      hooks: { beforeCreate: { url: rcv.url, mode: "transform", timeoutMs: 700 } },
    });
  });
  after(async () => {
    await rcv.close();
    await p.destroy();
  });

  it("approve → verdict 'proceed', writes NOTHING, logs a hook.test row", async () => {
    rcv.approve();
    const r = await mcp(p.mcpToken, "test_hook", { collection: "items", stage: "beforeCreate", data: { name: "Probe" } });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.verdict, "proceed");
    // Side-effect-free: no entry created.
    const q = await mcp(p.mcpToken, "query_entries", { collection: "items" });
    assert.equal(q.value.entries.length, 0, "test_hook must not write");
    // But the consult WAS logged as hook.test.
    const logged = await waitFor(async () => (await queryDeliveries(p.id)).find((d) => d.event === "hook.test"));
    assert.ok(logged, "the test consult is logged as hook.test");
  });

  it("reject → verdict 'rejected' with the hook's reason", async () => {
    rcv.reject("blocked by policy");
    const r = await mcp(p.mcpToken, "test_hook", { collection: "items", stage: "beforeCreate", data: { name: "X" } });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.verdict, "rejected");
    assert.equal(r.value.hookResponse.error, "blocked by policy");
  });

  it("transform → verdict 'replaced' with finalData + a passing validationOfFinalData", async () => {
    rcv.transform({ name: "Clean", slug: "clean" });
    const r = await mcp(p.mcpToken, "test_hook", { collection: "items", stage: "beforeCreate", data: { name: "messy INPUT" } });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.verdict, "replaced");
    assert.deepEqual(r.value.finalData, { name: "Clean", slug: "clean" });
    assert.equal(r.value.validationOfFinalData.ok, true);
  });

  it("transform returning INVALID data → validationOfFinalData reports the failure", async () => {
    rcv.transform({ slug: "no-name" }); // missing required `name`
    const r = await mcp(p.mcpToken, "test_hook", { collection: "items", stage: "beforeCreate", data: { name: "ok" } });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.verdict, "replaced");
    assert.equal(r.value.validationOfFinalData.ok, false);
    assert.match(r.value.validationOfFinalData.error, /name|required/i);
  });

  it("beforeUpdate: entryId loads the pre-image and the hook sees the MERGED candidate", async () => {
    // A separate collection with a beforeUpdate validate hook.
    await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "body", label: "B", type: "text", publicRead: true },
      ],
      hooks: { beforeUpdate: { url: rcv.url, mode: "validate", timeoutMs: 700 } },
    });
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "Orig", body: "keep" } });
    rcv.approve();
    rcv.received.length = 0;
    const r = await mcp(p.mcpToken, "test_hook", { collection: "docs", stage: "beforeUpdate", entryId: c.value.id, data: { title: "New" } });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.verdict, "proceed");
    const got = rcv.received.find((x) => x.json?.event === "entry.before_update");
    assert.ok(got, "the hook was consulted for an update");
    assert.equal(got.json.candidate.data.title, "New", "candidate carries the patched value");
    assert.equal(got.json.candidate.data.body, "keep", "candidate is the MERGED snapshot (untouched field retained)");
    assert.equal(got.json.current.data.title, "Orig", "current pre-image is included");
    // Still no write: the doc is unchanged.
    const g = await mcp(p.mcpToken, "get_entry", { collection: "docs", id: c.value.id });
    assert.equal(g.value.data.title, "Orig", "test_hook did not apply the update");
  });

  it("beforeUpdate without entryId, and a stage with no hook, are rejected", async () => {
    const noId = await mcp(p.mcpToken, "test_hook", { collection: "docs", stage: "beforeUpdate", data: { title: "x" } });
    assert.ok(!noId.ok && /entryId/.test(noId.errorText), noId.errorText);
    // A collection with no configured hook for the stage.
    await mcp(p.mcpToken, "define_collection", {
      name: "plain",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
    });
    const noHook = await mcp(p.mcpToken, "test_hook", { collection: "plain", stage: "beforeCreate", data: { x: "y" } });
    assert.ok(!noHook.ok && /no beforeCreate hook/.test(noHook.errorText), noHook.errorText);
  });
});
