import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp, delivery, waitFor } from "./helpers.mjs";

// H3: collection-delete convergence. Deleting a collection appends a `deleted`
// tombstone per live entry BEFORE the cascade (entry_changes is FK-less), so a
// synced client converges. The H2 reader serves a tombstone only for entries
// that were delivery-visible; never-visible ones stay suppressed.
const sql = neon(process.env.DATABASE_URL);

describe("change feed: collection-delete tombstones (H3)", () => {
  let p, visibleId, hiddenId, cursor;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("changes-cdel");
    const d = await mcp(p.mcpToken, "define_collection", {
      name: "temp",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "published", label: "P", type: "boolean" }, // private; drives publicFilter
      ],
      publicFilter: [{ field: "published", op: "eq", value: true }],
    });
    assert.ok(d.ok, d.errorText);
    const v = await mcp(p.mcpToken, "create_entry", { collection: "temp", data: { title: "shown", published: true } });
    const h = await mcp(p.mcpToken, "create_entry", { collection: "temp", data: { title: "hidden", published: false } });
    visibleId = v.value.id;
    hiddenId = h.value.id;
    cursor = (await delivery(p.deliveryToken, "/changes")).json.cursor; // bootstrap
    // ensure the creates are past the hold-back before we delete
    await waitFor(
      async () => {
        const r = await delivery(p.deliveryToken, `/changes?since=${cursor}&limit=500`);
        return (r.json.changes ?? []).some((c) => c.id === visibleId) ? true : null;
      },
      { timeoutMs: 9000, stepMs: 700 },
    );
  });
  after(async () => {
    await p.destroy();
  });

  it("the delete plan discloses the tombstone count", async () => {
    const plan = await mcp(p.mcpToken, "delete_collection", { name: "temp" });
    assert.ok(plan.ok, plan.errorText);
    assert.equal(plan.value.plan.changeFeedTombstones, 2, "one tombstone per live entry");
    assert.match(plan.value.hint, /tombstone/);
  });

  it("delete appends tombstones for visible entries only; orphaned created rows stop surfacing", async () => {
    const del = await mcp(p.mcpToken, "delete_collection", { name: "temp", confirm: true });
    assert.ok(del.ok, del.errorText);

    // Both entries got a tombstone ROW written (direct SQL — feed gating is separate).
    const rows = await sql`SELECT entry_id, kind FROM entry_changes
      WHERE project_id = ${p.id} AND kind = 'deleted' AND entry_id IN (${visibleId}, ${hiddenId})`;
    assert.equal(rows.length, 2, "a tombstone row per live entry, regardless of visibility");

    // The DELIVERY feed serves the visible entry's tombstone, suppresses the hidden one.
    const changes = await waitFor(
      async () => {
        const r = await delivery(p.deliveryToken, `/changes?since=${cursor}&limit=500`);
        const cs = r.json.changes ?? [];
        return cs.some((c) => c.id === visibleId && c.kind === "deleted") ? cs : null;
      },
      { timeoutMs: 9000, stepMs: 700 },
    );
    const tomb = changes.find((c) => c.id === visibleId && c.kind === "deleted");
    assert.ok(tomb, "visible entry's tombstone is served");
    assert.equal(tomb.data, undefined, "tombstone carries no data");
    // Its earlier `created` no longer surfaces (collection orphaned → H2 drops it).
    assert.ok(!changes.some((c) => c.id === visibleId && c.kind === "created"), "orphaned created dropped");
    // The never-visible entry is fully suppressed (no tombstone in the feed).
    assert.ok(!changes.some((c) => c.id === hiddenId), "never-visible entry stays suppressed");
  });
});
