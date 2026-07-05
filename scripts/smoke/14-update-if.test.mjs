import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

describe("update_entry_if: atomic CAS + guarded increment", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("update-if");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "shows",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "seats", label: "Seats", type: "number", min: 0 },
        { name: "status", label: "Status", type: "enum", options: ["draft", "published"] },
      ],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  async function makeShow(data) {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "shows", data });
    assert.ok(r.ok, r.errorText);
    return r.value.id;
  }

  it("CAS: transition applies once, second attempt conflicts", async () => {
    const id = await makeShow({ title: "Opening night", status: "draft" });
    const publish = () =>
      mcp(p.mcpToken, "update_entry_if", {
        collection: "shows",
        id,
        if: [{ field: "status", op: "eq", value: "draft" }],
        data: { status: "published" },
      });

    const first = await publish();
    assert.ok(first.ok, first.errorText);
    assert.equal(first.value.data.status, "published");

    const second = await publish();
    assert.ok(!second.ok && /\[E_CONFLICT\]/.test(second.errorText), second.errorText);
    assert.match(second.errorText, /re-read and retry/);
  });

  it("guarded increment: min constraint stops the last seat going negative", async () => {
    const id = await makeShow({ title: "Matinee", seats: 2 });
    const book = () =>
      mcp(p.mcpToken, "update_entry_if", {
        collection: "shows",
        id,
        increment: { field: "seats", by: -1 },
      });

    assert.equal((await book()).value.data.seats, 1);
    assert.equal((await book()).value.data.seats, 0);
    const soldOut = await book();
    assert.ok(!soldOut.ok && /\[E_CONFLICT\]/.test(soldOut.errorText), soldOut.errorText);

    const check = await mcp(p.mcpToken, "get_entry", { collection: "shows", id });
    assert.equal(check.value.data.seats, 0); // never went negative
  });

  it("concurrency: N parallel bookings never oversell", async () => {
    const id = await makeShow({ title: "Gala", seats: 3 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        mcp(p.mcpToken, "update_entry_if", {
          collection: "shows",
          id,
          increment: { field: "seats", by: -1 },
        }),
      ),
    );
    const wins = results.filter((r) => r.ok).length;
    const conflicts = results.filter((r) => !r.ok && /E_CONFLICT/.test(r.errorText)).length;
    assert.equal(wins, 3, `expected exactly 3 successful bookings, got ${wins}`);
    assert.equal(conflicts, 2);

    const check = await mcp(p.mcpToken, "get_entry", { collection: "shows", id });
    assert.equal(check.value.data.seats, 0);
  });

  it("validation: bad increments, empty ops, unknown ids", async () => {
    const id = await makeShow({ title: "Late show", seats: 5 });

    const notNumber = await mcp(p.mcpToken, "update_entry_if", {
      collection: "shows",
      id,
      increment: { field: "title", by: 1 },
    });
    assert.ok(!notNumber.ok && /number fields: seats/.test(notNumber.errorText), notNumber.errorText);

    const both = await mcp(p.mcpToken, "update_entry_if", {
      collection: "shows",
      id,
      data: { seats: 10 },
      increment: { field: "seats", by: 1 },
    });
    assert.ok(!both.ok && /cannot also appear in data/.test(both.errorText), both.errorText);

    const nothing = await mcp(p.mcpToken, "update_entry_if", { collection: "shows", id });
    assert.ok(!nothing.ok && /nothing to apply/.test(nothing.errorText), nothing.errorText);

    const missing = await mcp(p.mcpToken, "update_entry_if", {
      collection: "shows",
      id: "00000000-0000-0000-0000-000000000000",
      increment: { field: "seats", by: -1 },
    });
    assert.ok(!missing.ok && /\[E_NOT_FOUND\]/.test(missing.errorText), missing.errorText);

    const badPatch = await mcp(p.mcpToken, "update_entry_if", {
      collection: "shows",
      id,
      data: { status: "cancelled" },
    });
    assert.ok(!badPatch.ok && /\[E_VALIDATION\]/.test(badPatch.errorText), badPatch.errorText);
  });

  it("increment on a row missing the field conflicts instead of corrupting", async () => {
    const id = await makeShow({ title: "No seats yet" });
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "shows",
      id,
      increment: { field: "seats", by: 1 },
    });
    assert.ok(!r.ok && /\[E_CONFLICT\]/.test(r.errorText), r.errorText);
  });
});
