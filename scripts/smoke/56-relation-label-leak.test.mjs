import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// F3 (HAv1): a relation's {id,label} must honour the TARGET collection's
// publicFilter — the label channel previously bypassed the row gate that
// list/get/expand enforce, leaking a hidden row's label.
describe("F3: relation label honours the target's publicFilter", () => {
  let p, hiddenTripId, reviewId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("f3-labels");
    await mcp(p.mcpToken, "define_collection", {
      name: "trips",
      fields: [
        { name: "name", label: "Name", type: "text", publicRead: true },
        { name: "published", label: "Published", type: "boolean" },
      ],
      publicFilter: [{ field: "published", op: "eq", value: true }],
    });
    const hidden = await mcp(p.mcpToken, "create_entry", {
      collection: "trips",
      data: { name: "UNRELEASED Antarctica", published: false },
    });
    hiddenTripId = hidden.value.id;

    // reviews are all public (no publicFilter); each points at a trip.
    await mcp(p.mcpToken, "define_collection", {
      name: "reviews",
      fields: [
        { name: "body", label: "Body", type: "text", publicRead: true },
        { name: "trip", label: "Trip", type: "relation", targetCollection: "trips", labelField: "name", publicRead: true },
      ],
    });
    const rev = await mcp(p.mcpToken, "create_entry", {
      collection: "reviews",
      data: { body: "loved it", trip: hiddenTripId },
    });
    reviewId = rev.value.id;
  });
  after(() => p.destroy());

  it("delivery read masks the label of a publicFilter-hidden target", async () => {
    const r = await delivery(p.deliveryToken, "/reviews");
    assert.equal(r.status, 200);
    const row = r.json.data.find((x) => x.id === reviewId);
    assert.ok(row, "review itself is public and readable");
    // Fail-closed: label masked to the id, hidden name never disclosed.
    assert.deepEqual(row.trip, { id: hiddenTripId, label: hiddenTripId });
    assert.ok(!JSON.stringify(row).includes("UNRELEASED"), "hidden label must not leak");
  });

  it("a published target's label still resolves normally", async () => {
    const pub = await mcp(p.mcpToken, "create_entry", {
      collection: "trips",
      data: { name: "Public Tour", published: true },
    });
    const rev = await mcp(p.mcpToken, "create_entry", {
      collection: "reviews",
      data: { body: "nice", trip: pub.value.id },
    });
    const r = await delivery(p.deliveryToken, "/reviews");
    const row = r.json.data.find((x) => x.id === rev.value.id);
    assert.deepEqual(row.trip, { id: pub.value.id, label: "Public Tour" });
  });
});
