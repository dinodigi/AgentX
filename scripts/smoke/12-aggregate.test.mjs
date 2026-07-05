import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

describe("aggregate_entries: dashboards in one query", () => {
  let p;
  let guideIds = {};
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("aggregate");
    await mcp(p.mcpToken, "define_collection", {
      name: "guides",
      fields: [{ name: "name", label: "Name", type: "text", required: true }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "bookings",
      fields: [
        { name: "guide", label: "Guide", type: "relation", targetCollection: "guides", labelField: "name" },
        { name: "amount", label: "Amount", type: "number", required: true },
        { name: "status", label: "Status", type: "enum", options: ["pending", "confirmed"] },
        { name: "note", label: "Note", type: "text" },
      ],
    });
    for (const name of ["Ada", "Lin"]) {
      const r = await mcp(p.mcpToken, "create_entry", { collection: "guides", data: { name } });
      guideIds[name] = r.value.id;
    }
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "bookings",
      entries: [
        { guide: guideIds.Ada, amount: 100, status: "confirmed" },
        { guide: guideIds.Ada, amount: 50, status: "pending" },
        { guide: guideIds.Lin, amount: 200, status: "confirmed" },
      ],
    });
  });
  after(() => p.destroy());

  it("count/sum/avg/min/max in one call, no rows fetched", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "bookings",
      aggregates: [
        { fn: "count" },
        { fn: "sum", field: "amount" },
        { fn: "avg", field: "amount" },
        { fn: "min", field: "amount" },
        { fn: "max", field: "amount" },
      ],
    });
    assert.ok(r.ok, r.errorText);
    const byFn = Object.fromEntries(r.value.results.map((x) => [x.fn, x.value]));
    assert.equal(byFn.count, 3);
    assert.equal(byFn.sum, 350);
    assert.ok(Math.abs(byFn.avg - 350 / 3) < 0.001);
    assert.equal(byFn.min, 50);
    assert.equal(byFn.max, 200);
  });

  it("groupBy enum composes with where filters", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "bookings",
      aggregates: [{ fn: "sum", field: "amount" }, { fn: "count" }],
      groupBy: "status",
      where: [{ field: "amount", op: "gt", value: 60 }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.groupBy, "status");
    assert.equal(r.value.truncatedGroups, false);
    assert.equal(r.value.groups.length, 1); // pending's only row (50) is filtered out
    assert.equal(r.value.groups[0].key, "confirmed");
    assert.equal(r.value.groups[0].results[0].value, 300);
    assert.equal(r.value.groups[0].results[1].value, 2);
  });

  it("groupBy relation resolves group labels", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "bookings",
      aggregates: [{ fn: "sum", field: "amount" }],
      groupBy: "guide",
    });
    assert.ok(r.ok, r.errorText);
    const byLabel = Object.fromEntries(r.value.groups.map((g) => [g.label, g]));
    assert.equal(byLabel.Ada.key, guideIds.Ada);
    assert.equal(byLabel.Ada.results[0].value, 150);
    assert.equal(byLabel.Lin.results[0].value, 200);
    // Largest group first (Ada has 2 bookings).
    assert.equal(r.value.groups[0].label, "Ada");
  });

  it("validation: non-number aggregates, bad groupBy, count with field", async () => {
    const text = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "bookings",
      aggregates: [{ fn: "sum", field: "note" }],
    });
    assert.ok(!text.ok && /number fields: amount/.test(text.errorText), text.errorText);

    const badGroup = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "bookings",
      aggregates: [{ fn: "count" }],
      groupBy: "amount",
    });
    assert.ok(!badGroup.ok && /groupable: guide, status/.test(badGroup.errorText), badGroup.errorText);

    const countField = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "bookings",
      aggregates: [{ fn: "count", field: "amount" }],
    });
    assert.ok(!countField.ok && /omit field/.test(countField.errorText), countField.errorText);
  });
});
