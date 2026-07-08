import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, startWebhookReceiver, waitFor } from "./helpers.mjs";

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

describe("update_entry_if: SQL-faithful failure diagnosis (B1)", () => {
  let p, receiver;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("cas-diag");
    receiver = await startWebhookReceiver();
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "slots",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "seats", label: "Seats", type: "number", min: 0 },
        { name: "active", label: "Active", type: "boolean" },
        { name: "n", label: "N", type: "number" },
      ],
      events: { updated: [{ type: "webhook", url: receiver.url }] },
    });
    assert.ok(def.ok, def.errorText);
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  const make = async (data) => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "slots", data });
    assert.ok(r.ok, r.errorText);
    return r.value.id;
  };

  it("not_found: unknown id is E_NOT_FOUND", async () => {
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "slots",
      id: "00000000-0000-4000-8000-000000000000",
      data: { title: "x" },
    });
    assert.ok(!r.ok && /\[E_NOT_FOUND\]/.test(r.errorText), r.errorText);
  });

  it("unset: incrementing an absent field names the field, not a generic conflict", async () => {
    const id = await make({ title: "no seats yet" }); // seats omitted
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "slots",
      id,
      increment: { field: "seats", by: 1 },
    });
    assert.ok(!r.ok && /\[E_CONFLICT\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /field "seats" is not set on this entry/);
  });

  it("bounds: an out-of-range increment reports the bound and the current value", async () => {
    const id = await make({ title: "sold out", seats: 0 });
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "slots",
      id,
      increment: { field: "seats", by: -1 },
    });
    assert.ok(!r.ok && /\[E_CONFLICT\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /would go below min 0/);
    assert.match(r.errorText, /current value is 0/);
  });

  it("conflict: a failed if-clause is named (SQL-faithful — pins against JS-coercion misdiagnosis)", async () => {
    // `active` key is ABSENT. SQL: data->>'active' is NULL, so `= false` is NULL
    // and matches no row. A JS re-check would coerce Boolean(undefined)===false
    // === true and misreport a concurrent change; the diagnostic SELECT must not.
    const id = await make({ title: "flagless" });
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "slots",
      id,
      if: [{ field: "active", op: "eq", value: false }],
      data: { n: 5 },
    });
    assert.ok(!r.ok && /\[E_CONFLICT\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /active eq false/);
    assert.doesNotMatch(r.errorText, /changed concurrently/);
  });

  it("conflict: a failed if-clause with no increment guards names only the clause", async () => {
    const id = await make({ title: "t", seats: 3 });
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "slots",
      id,
      if: [{ field: "seats", op: "gt", value: 10 }],
      data: { title: "t2" },
    });
    assert.ok(!r.ok && /\[E_CONFLICT\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /seats gt 10/);
  });

  it("success: the CAS updated event now carries previous + changedFields", async () => {
    const id = await make({ title: "opening", seats: 5 });
    const ok = await mcp(p.mcpToken, "update_entry_if", {
      collection: "slots",
      id,
      if: [{ field: "seats", op: "gt", value: 0 }],
      increment: { field: "seats", by: -1 },
    });
    assert.ok(ok.ok, ok.errorText);
    const hit = await waitFor(() =>
      receiver.received.find((r) => r.event === "entry.updated" && r.entry?.id === id),
    );
    assert.ok(hit, "receiver should get the CAS entry.updated");
    assert.ok(hit.previous, "CAS updated event must include previous");
    assert.equal(hit.previous.data.seats, 5);
    assert.equal(hit.entry.data.seats, 4);
    assert.ok(Array.isArray(hit.changedFields) && hit.changedFields.includes("seats"), JSON.stringify(hit.changedFields));
  });
});

describe("update_entry_if: integer-parity diagnosis (B fix)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("cas-parity");
    await mcp(p.mcpToken, "define_collection", {
      name: "tallies",
      fields: [{ name: "n", label: "N", type: "number" }],
    });
  });
  after(() => p.destroy());

  it("a legacy fractional value on an integer field gets a precise diagnosis, not 'concurrent change'", async () => {
    const created = await mcp(p.mcpToken, "create_entry", { collection: "tallies", data: { n: 2.5 } });
    assert.ok(created.ok, created.errorText);
    // Tighten to integer AFTER the fractional row exists.
    const tighten = await mcp(p.mcpToken, "define_collection", {
      name: "tallies",
      fields: [{ name: "n", label: "N", type: "number", integer: true }],
    });
    assert.ok(tighten.ok, tighten.errorText);

    const cas = await mcp(p.mcpToken, "update_entry_if", {
      collection: "tallies",
      id: created.value.id,
      increment: { field: "n", by: 1 },
    });
    assert.ok(!cas.ok && /\[E_CONFLICT\]/.test(cas.errorText), cas.errorText);
    assert.match(cas.errorText, /is not whole/);
    assert.doesNotMatch(cas.errorText, /changed concurrently/);
  });
});
