import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, startHookReceiver, mcp, waitFor, queryDeliveries } from "./helpers.mjs";

// I5: bulk_create_entries runs the beforeCreate hook PER ITEM (bounded
// concurrency), with per-item E_HOOK_* outcomes and a batch-size budget cap.
describe("bulk hooks (I5)", () => {
  let p, rcv;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("bulk-hooks");
    rcv = await startHookReceiver();
  });
  after(async () => {
    await rcv.close();
    await p.destroy();
  });

  it("a mixed batch inserts the passing items and reports E_HOOK_REJECTED for the rest", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
      hooks: { beforeCreate: { url: rcv.url, mode: "validate", timeoutMs: 700 } },
    });
    rcv.rejectMatching("BLOCK");
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "leads",
      entries: [{ title: "keep-1" }, { title: "BLOCK-2" }, { title: "keep-3" }, { title: "BLOCK-4" }],
    });
    assert.ok(r.ok, r.errorText);
    const byIndex = Object.fromEntries(r.value.results.map((x) => [x.index, x]));
    assert.ok(byIndex[0].ok && byIndex[2].ok, "clean items insert");
    assert.ok(!byIndex[1].ok && byIndex[1].code === "E_HOOK_REJECTED", JSON.stringify(byIndex[1]));
    assert.ok(!byIndex[3].ok && byIndex[3].code === "E_HOOK_REJECTED", JSON.stringify(byIndex[3]));
    // Only the two passing rows exist.
    const q = await mcp(p.mcpToken, "query_entries", { collection: "leads" });
    assert.equal(q.value.entries.length, 2);
    // Each consult logged its own delivery row (4 items → 4 hook.before_create rows).
    const rows = await waitFor(async () => {
      const d = (await queryDeliveries(p.id)).filter((x) => x.event === "hook.before_create");
      return d.length >= 4 ? d : null;
    });
    assert.ok(rows, "one delivery row per item consult");
  });

  it("a transform hook rewrites each item in the batch", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "widgets",
      fields: [
        { name: "name", label: "N", type: "text", required: true, publicRead: true },
        { name: "tag", label: "G", type: "text", publicRead: true },
      ],
      hooks: { beforeCreate: { url: rcv.url, mode: "transform", timeoutMs: 700 } },
    });
    rcv.transform({ name: "Standardized", tag: "bulk" });
    const r = await mcp(p.mcpToken, "bulk_create_entries", { collection: "widgets", entries: [{ name: "raw a" }, { name: "raw b" }] });
    assert.ok(r.ok && r.value.results.every((x) => x.ok), JSON.stringify(r.value));
    const ids = r.value.results.map((x) => x.id);
    for (const id of ids) {
      const g = await mcp(p.mcpToken, "get_entry", { collection: "widgets", id });
      assert.equal(g.value.data.name, "Standardized");
      assert.equal(g.value.data.tag, "bulk");
    }
  });

  it("a batch larger than the hook's budget cap is refused with a split hint", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "slow",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
      hooks: { beforeCreate: { url: rcv.url, mode: "validate", timeoutMs: 5000 } }, // cap = floor(7000/5000)*5 = 5
    });
    rcv.approve();
    const entries = (n) => Array.from({ length: n }, (_, i) => ({ x: `e${i}` }));
    const over = await mcp(p.mcpToken, "bulk_create_entries", { collection: "slow", entries: entries(6) });
    assert.ok(!over.ok && /at most 5 items|split the batch/.test(over.errorText), over.errorText);
    const okAtCap = await mcp(p.mcpToken, "bulk_create_entries", { collection: "slow", entries: entries(5) });
    assert.ok(okAtCap.ok && okAtCap.value.results.every((x) => x.ok), okAtCap.errorText);
  });
});
