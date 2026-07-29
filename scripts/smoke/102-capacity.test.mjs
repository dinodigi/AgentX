import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// Burn-down CP8 — `capacity: N`, at most N rows per key.
//
// `unique` gave exactly-one-per-key and nothing gave AT MOST N, so booking
// capacity had to be a count-then-insert in application code. That races: two
// callers both count 9 of 10 and both insert, and the slot oversells. The
// reporter asked for it precisely because the workaround cannot be made correct
// from outside the database.

describe("capacity — at most N rows per key", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("capacity");
    await mcp(p.mcpToken, "define_collection", {
      name: "bookings",
      fields: [
        { name: "who", label: "W", type: "text", required: true },
        { name: "slot", label: "S", type: "text", capacity: 3 },
      ],
    });
  });
  after(() => p.destroy());

  const book = (who, slot) =>
    mcp(p.mcpToken, "create_entry", { collection: "bookings", data: { who, slot } });

  it("fills to capacity, then refuses with a message naming the key", async () => {
    for (const who of ["a", "b", "c"]) {
      const r = await book(who, "monday");
      assert.ok(r.ok, `${who} should fit: ${r.errorText}`);
    }
    const overflow = await book("d", "monday");
    assert.equal(overflow.ok, false, "the 4th booking must be refused");
    assert.match(overflow.errorText, /monday/, "the error must name the full key");
    assert.match(overflow.errorText, /at most 3/);
  });

  it("a different key has its own capacity", async () => {
    const r = await book("e", "tuesday");
    assert.ok(r.ok, r.errorText);
  });

  it("THE POINT: concurrent bookings cannot oversell", async () => {
    // The race the workaround could not close. Ten callers rush a 3-seat slot;
    // exactly 3 may win. A count-then-insert in application code lets several
    // read "2 taken" simultaneously and all insert.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => book(`rush${i}`, "friday")),
    );
    const won = results.filter((r) => r.ok).length;
    assert.equal(won, 3, `exactly 3 may win, got ${won}`);

    const count = await mcp(p.mcpToken, "count_entries", {
      collection: "bookings",
      where: [{ field: "slot", op: "eq", value: "friday" }],
    });
    assert.equal(count.value.count ?? count.value, 3, "and the table must agree");
  });

  it("an unset key is not counted — capacity applies per VALUE", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await mcp(p.mcpToken, "create_entry", {
        collection: "bookings",
        data: { who: `nokey${i}` },
      });
      assert.ok(r.ok, r.errorText);
    }
  });

  it("MOVING a row into a full slot is refused too — not just inserts", async () => {
    const r = await book("mover", "wednesday");
    assert.ok(r.ok, r.errorText);
    const moved = await mcp(p.mcpToken, "update_entry", {
      collection: "bookings",
      id: r.value.id,
      data: { slot: "monday" }, // already full
    });
    assert.equal(moved.ok, false, "an UPDATE must respect capacity");
  });

  it("updating a row WITHOUT changing its key still works", async () => {
    // The row already counts toward its own slot; re-counting it would make a
    // full slot permanently uneditable.
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "bookings",
      where: [{ field: "slot", op: "eq", value: "monday" }],
    });
    const row = q.value.entries[0];
    const r = await mcp(p.mcpToken, "update_entry", {
      collection: "bookings",
      id: row.id,
      data: { who: "renamed" },
    });
    assert.ok(r.ok, `a row in a full slot must stay editable: ${r.errorText}`);
  });

  it("raising capacity lets more in; lowering it does not evict", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "bookings",
      fields: [
        { name: "who", label: "W", type: "text", required: true },
        { name: "slot", label: "S", type: "text", capacity: 4 },
      ],
    });
    const r = await book("fourth", "monday");
    assert.ok(r.ok, `capacity 4 must admit a 4th: ${r.errorText}`);
  });

  it("capacity + unique is refused — unique already means capacity 1", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "conflicted",
      fields: [{ name: "k", label: "K", type: "text", unique: true, capacity: 2 }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /conflict|unique/i);
  });

  it("capacity on a structured field is refused", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "structured",
      fields: [
        { name: "tags", label: "T", type: "array", item: { type: "text" }, capacity: 2 },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not valid on array/);
  });
});
