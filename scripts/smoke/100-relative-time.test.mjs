import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// Burn-down CP7 / field-signal C2 — relative time in where clauses, so a live
// window is expressible in publicFilter.
//
// The reporter built manually-launched ad banners. The "is it launched" half
// was database-enforced and worked; the "is it inside its window" half could
// not be expressed, so they ran an hourly sweep that transitioned expired rows
// — leaving a campaign served up to an hour past its contracted end, which for
// ad inventory is a billing conversation. They also noticed define_schedule
// already accepted {hoursAgo:n}: the vocabulary existed, it just was not wired
// to where clauses. This uses that SAME vocabulary rather than inventing one.

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

describe("C2 — relative time makes a live window database-enforced", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("relative-time");
    await mcp(p.mcpToken, "define_collection", {
      name: "campaigns",
      fields: [
        { name: "name", label: "N", type: "text", required: true, publicRead: true },
        { name: "starts_at", label: "S", type: "date", publicRead: true },
        { name: "ends_at", label: "E", type: "date", publicRead: true },
      ],
      // THE SHAPE that was impossible: serve only while now is inside the window.
      publicFilter: [
        { field: "starts_at", op: "lt", value: { hoursAgo: 0 } },
        { field: "ends_at", op: "gt", value: { hoursAgo: 0 } },
      ],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "campaigns",
      entries: [
        { name: "live now", starts_at: iso(-3600_000), ends_at: iso(3600_000) },
        { name: "expired", starts_at: iso(-7200_000), ends_at: iso(-60_000) },
        { name: "not started", starts_at: iso(3600_000), ends_at: iso(7200_000) },
      ],
    });
  });
  after(() => p.destroy());

  it("THE POINT: delivery serves only the row inside its window", async () => {
    const res = await delivery(p.deliveryToken, "/campaigns");
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json.data.map((d) => d.name), ["live now"]);
  });

  it("an expired row is invisible IMMEDIATELY, with no sweep and no gap", async () => {
    // The sweep workaround's whole cost was the gap between ticks. Ending a
    // campaign one second ago must remove it on the very next request.
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "campaigns",
      data: { name: "just ended", starts_at: iso(-7200_000), ends_at: iso(-1000) },
    });
    assert.ok(r.ok, r.errorText);
    const res = await delivery(p.deliveryToken, "/campaigns");
    assert.doesNotMatch(JSON.stringify(res.json.data), /just ended/);
  });

  it("MCP where clauses take it too — same vocabulary, both surfaces", async () => {
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "campaigns",
      where: [{ field: "ends_at", op: "gt", value: { hoursAgo: 0 } }],
    });
    assert.ok(q.ok, q.errorText);
    assert.deepEqual(q.value.entries.map((e) => e.data.name).sort(), ["live now", "not started"]);
  });

  it("a NEGATIVE value reaches into the future", async () => {
    // {hoursAgo:-1.5} is 90 minutes out. "live now" ends in 1h so it qualifies;
    // "not started" ends in 2h so it does not. Deliberately NOT -2, which lands
    // exactly on that row's ends_at and makes the result a timing race.
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "campaigns",
      where: [
        { field: "ends_at", op: "gt", value: { hoursAgo: 0 } },
        { field: "ends_at", op: "lt", value: { hoursAgo: -1.5 } },
      ],
    });
    assert.ok(q.ok, q.errorText);
    assert.deepEqual(q.value.entries.map((e) => e.data.name), ["live now"]);
  });

  it("daysAgo works and agrees with hoursAgo", async () => {
    const byDays = await mcp(p.mcpToken, "query_entries", {
      collection: "campaigns",
      where: [{ field: "starts_at", op: "gt", value: { daysAgo: 1 } }],
    });
    const byHours = await mcp(p.mcpToken, "query_entries", {
      collection: "campaigns",
      where: [{ field: "starts_at", op: "gt", value: { hoursAgo: 24 } }],
    });
    assert.ok(byDays.ok, byDays.errorText);
    assert.equal(byDays.value.entries.length, byHours.value.entries.length);
  });

  it("relative time on a NON-date field is refused, not stringified", async () => {
    // "[object Object]" would match nothing while looking like a working filter.
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "campaigns",
      where: [{ field: "name", op: "eq", value: { hoursAgo: 0 } }],
    });
    assert.equal(q.ok, false);
    assert.match(q.errorText, /only valid on a date field/);
  });

  it("THE OTHER HALF: a time-varying publicFilter is NOT edge-cached", async () => {
    // Fixing the filter but leaving the CDN caching for 60s would reproduce the
    // reporter's exact symptom — a row served past its end — just faster.
    const res = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/campaigns`, {
      headers: { authorization: `Bearer ${p.deliveryToken}` },
    });
    const cc = res.headers.get("cache-control") ?? "";
    assert.doesNotMatch(cc, /s-maxage=[1-9]/, `a time-varying filter must not be shared-cached: ${cc}`);
  });

  it("...while an ORDINARY collection still gets its edge cache", async () => {
    // The cost is scoped to collections that asked for a window, not global.
    await mcp(p.mcpToken, "define_collection", {
      name: "statics",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
    await mcp(p.mcpToken, "create_entry", { collection: "statics", data: { title: "x" } });
    const res = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/statics`, {
      headers: { authorization: `Bearer ${p.deliveryToken}` },
    });
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage=\d+/);
  });
});
