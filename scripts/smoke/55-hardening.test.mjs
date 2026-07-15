import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// Regression coverage for the HAv1 scorecard Batch-1 fixes:
//   F2 — public-write mass-assignment (visibility-gate invariant)
//   D3 — oversized body → worker OOM (bounded read before parse)
//   D4 — filter-clause amplification → outage (anyOf / where caps)
describe("hardening: HAv1 Batch-1 fixes", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("hardening");
    // A public-review form: rating/body are submitter content (publicRead);
    // `approved` is the moderation gate the publicFilter keys on.
    await mcp(p.mcpToken, "define_collection", {
      name: "reviews",
      publicWrite: true,
      fields: [
        { name: "rating", label: "Rating", type: "number", publicRead: true },
        { name: "body", label: "Body", type: "text", publicRead: true },
        { name: "approved", label: "Approved", type: "boolean" },
      ],
      publicFilter: [{ field: "approved", op: "eq", value: true }],
    });
  });
  after(() => p.destroy());

  it("F2: anonymous form submit succeeds for content fields", async () => {
    const r = await delivery(p.deliveryToken, "/reviews", {
      method: "POST",
      body: { rating: 5, body: "great trip" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  });

  it("F2: anonymous write to a publicFilter-gated field is rejected (no self-approval)", async () => {
    const r = await delivery(p.deliveryToken, "/reviews", {
      method: "POST",
      body: { rating: 5, body: "sneaky", approved: true },
    });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.ok(/approved/.test(r.json.error), r.json.error);
  });

  it("F2: a submitted review is not auto-published (stays behind the gate)", async () => {
    await delivery(p.deliveryToken, "/reviews", {
      method: "POST",
      body: { rating: 4, body: "pending review" },
    });
    const list = await delivery(p.deliveryToken, "/reviews");
    assert.equal(list.status, 200);
    // Nothing the anonymous form created is approved, so the gate hides it all.
    assert.equal(list.json.data.length, 0, "no anonymously-created review should be visible");
  });

  it("D3: an oversized body is rejected 413 before parse", async () => {
    const r = await delivery(p.deliveryToken, "/reviews", {
      method: "POST",
      body: { body: "A".repeat(1_100_000) }, // > 1 MiB delivery cap
    });
    assert.equal(r.status, 413, JSON.stringify(r.json));
  });

  it("D4: an over-cap anyOf is rejected, not compiled into a giant query", async () => {
    const overCap = Array.from({ length: 201 }, (_, i) => ({ field: "rating", op: "eq", value: i }));
    const bad = await mcp(p.mcpToken, "query_entries", {
      collection: "reviews",
      where: [{ anyOf: overCap }],
    });
    assert.equal(bad.ok, false, "201-clause anyOf should be rejected");

    const atCap = Array.from({ length: 200 }, (_, i) => ({ field: "rating", op: "eq", value: i }));
    const ok = await mcp(p.mcpToken, "query_entries", {
      collection: "reviews",
      where: [{ anyOf: atCap }],
    });
    assert.equal(ok.ok, true, "200-clause anyOf is at the cap and allowed");
  });

  it("D4: an over-cap where array is rejected by the runtime backstop", async () => {
    const overCap = Array.from({ length: 101 }, () => ({ field: "rating", op: "eq", value: 1 }));
    const bad = await mcp(p.mcpToken, "query_entries", { collection: "reviews", where: overCap });
    assert.equal(bad.ok, false, "101 where clauses should be rejected");
  });
});
