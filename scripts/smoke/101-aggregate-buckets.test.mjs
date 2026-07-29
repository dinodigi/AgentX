import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// Burn-down CP7 / field-signal C3 — date bucketing and a second groupBy
// dimension. The by-month report pipeline, open since 2026-07-18.
//
// groupBy took ONE enum/relation field, so "revenue by month" and "leads by
// source AND stage" both had to be done by fetching rows and grouping in the
// client — the same "correct at small scale, wrong at real scale" shape as C1.

describe("C3 — date buckets and a second dimension", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("agg-buckets");
    await mcp(p.mcpToken, "define_collection", {
      name: "deals",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "amount", label: "A", type: "number" },
        { name: "closed_at", label: "C", type: "date" },
        { name: "source", label: "S", type: "enum", options: ["web", "referral"] },
        { name: "stage", label: "St", type: "enum", options: ["won", "lost"] },
      ],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "deals",
      entries: [
        { title: "a", amount: 100, closed_at: "2026-01-10T00:00:00Z", source: "web", stage: "won" },
        { title: "b", amount: 200, closed_at: "2026-01-25T00:00:00Z", source: "web", stage: "lost" },
        { title: "c", amount: 300, closed_at: "2026-02-05T00:00:00Z", source: "referral", stage: "won" },
        { title: "d", amount: 400, closed_at: "2026-02-20T00:00:00Z", source: "web", stage: "won" },
      ],
    });
  });
  after(() => p.destroy());

  it("THE POINT: revenue by month, in one call", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "deals",
      aggregates: [{ fn: "sum", field: "amount" }],
      groupBy: { field: "closed_at", bucket: "month" },
    });
    assert.ok(r.ok, r.errorText);
    const byKey = Object.fromEntries(r.value.groups.map((g) => [g.key, g.results[0].value]));
    assert.deepEqual(byKey, { "2026-01": 300, "2026-02": 700 });
  });

  it("bucket granularities each produce their own axis", async () => {
    for (const [bucket, expected] of [
      ["year", ["2026"]],
      ["quarter", ["2026-Q1"]],
      ["day", ["2026-01-10", "2026-01-25", "2026-02-05", "2026-02-20"]],
    ]) {
      const r = await mcp(p.mcpToken, "aggregate_entries", {
        collection: "deals",
        aggregates: [{ fn: "count" }],
        groupBy: { field: "closed_at", bucket },
      });
      assert.ok(r.ok, `${bucket}: ${r.errorText}`);
      assert.deepEqual(r.value.groups.map((g) => g.key).sort(), expected, `bucket ${bucket}`);
    }
  });

  it("THE OTHER HALF: two dimensions give a cross-tab", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "deals",
      aggregates: [{ fn: "count" }],
      groupBy: ["source", "stage"],
    });
    assert.ok(r.ok, r.errorText);
    const cells = r.value.groups.map((g) => `${g.keys[0]}/${g.keys[1]}=${g.results[0].value}`).sort();
    assert.deepEqual(cells, ["referral/won=1", "web/lost=1", "web/won=2"]);
  });

  it("a bucketed date composes with a second dimension", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "deals",
      aggregates: [{ fn: "sum", field: "amount" }],
      groupBy: [{ field: "closed_at", bucket: "month" }, "source"],
    });
    assert.ok(r.ok, r.errorText);
    const cells = r.value.groups.map((g) => `${g.keys[0]}/${g.keys[1]}`).sort();
    assert.deepEqual(cells, ["2026-01/web", "2026-02/referral", "2026-02/web"]);
  });

  it("a date WITHOUT a bucket is refused — one group per row is a trap", async () => {
    // It would not error; it would produce a group per row and then truncate at
    // MAX_AGGREGATE_GROUPS, yielding a report that looks complete and is built
    // from an arbitrary slice.
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "deals",
      aggregates: [{ fn: "count" }],
      groupBy: "closed_at",
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /needs a bucket/);
  });

  it("a bucket on a NON-date field is refused", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "deals",
      aggregates: [{ fn: "count" }],
      groupBy: { field: "source", bucket: "month" },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /only valid on a date field/);
  });

  it("a third dimension is refused rather than silently truncating", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "deals",
      aggregates: [{ fn: "count" }],
      groupBy: ["source", "stage", { field: "closed_at", bucket: "month" }],
    });
    assert.equal(r.ok, false);
  });

  it("the SINGLE-dimension shape is unchanged — existing callers keep working", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "deals",
      aggregates: [{ fn: "count" }],
      groupBy: "source",
    });
    assert.ok(r.ok, r.errorText);
    // `key` must still be the group value, and `keys` must NOT appear for one
    // dimension — a caller reading g.key cannot have been broken by this.
    const web = r.value.groups.find((g) => g.key === "web");
    assert.ok(web, "key must still carry the group value");
    assert.equal(web.results[0].value, 3);
    assert.equal(web.keys, undefined, "no keys array for a single dimension");
  });

  it("ungrouped aggregation is untouched", async () => {
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "deals",
      aggregates: [{ fn: "sum", field: "amount" }, { fn: "count" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.results[0].value, 1000);
    assert.equal(r.value.results[1].value, 4);
  });
});
