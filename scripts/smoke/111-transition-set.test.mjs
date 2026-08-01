import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, waitFor } from "./helpers.mjs";

// WF-1 (wall 0cd6dce5, xvibe) — fields stamped AT transition time, in the same
// atomic UPDATE as the move. The reporter's exact case: resolved_at = now when
// status transitions to resolved. Before this, transition actions could notify
// but not mutate, and scheduled mutations stamp on sweep cadence — hours late.

describe("WF-1 — transitions[].set stamps atomically with the move", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("transition-set");
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "status", label: "S", type: "enum", options: ["open", "resolved", "reopened"] },
        { name: "resolved_at", label: "R", type: "date" },
        { name: "resolution", label: "Rs", type: "enum", options: ["fixed", "wontfix"] },
        { name: "reopen_count", label: "C", type: "number", integer: true },
      ],
      workflow: {
        field: "status",
        initial: "open",
        transitions: [
          {
            from: ["open", "reopened"],
            to: "resolved",
            actors: ["mcp"],
            set: { resolved_at: "now", resolution: { value: "fixed" } },
          },
          // A second branch with a DIFFERENT set — the case that breaks a
          // naive "flatten all sets" implementation, mirroring test 106's
          // per-branch `when` discipline.
          { from: "resolved", to: "reopened", actors: ["mcp"], set: { resolved_at: null } },
        ],
      },
    });
    assert.ok(r.ok, r.errorText);
  });
  after(() => p.destroy());

  const make = async () => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "t" } });
    assert.ok(r.ok, r.errorText);
    return r.value;
  };

  it("THE POINT: →resolved stamps resolved_at (now) and resolution (literal) in the same write", async () => {
    const e = await make();
    assert.ok(!("resolved_at" in e.data), "fixture: no stamp before the transition");
    const before = Date.now();
    const r = await mcp(p.mcpToken, "update_entry", {
      collection: "tickets", id: e.id, data: { status: "resolved" },
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.data.status, "resolved");
    assert.equal(r.value.data.resolution, "fixed", "the literal stamp landed");
    const t = Date.parse(r.value.data.resolved_at);
    assert.ok(Number.isFinite(t), `resolved_at must be a timestamp: ${r.value.data.resolved_at}`);
    assert.ok(Math.abs(t - before) < 30_000, "…and it is TRANSITION time, not some other time");
  });

  it("each branch keeps its OWN set: reopening UNSETS resolved_at (null spec)", async () => {
    const e = await make();
    await mcp(p.mcpToken, "update_entry", { collection: "tickets", id: e.id, data: { status: "resolved" } });
    const r = await mcp(p.mcpToken, "update_entry", {
      collection: "tickets", id: e.id, data: { status: "reopened" },
    });
    assert.ok(r.ok, r.errorText);
    assert.ok(!("resolved_at" in r.value.data), "null in set = unset, and only THIS branch's set applied");
    assert.equal(r.value.data.resolution, "fixed", "the other branch's fields are untouched");
  });

  it("the stamp OVERRIDES the caller's same-key value — the machine's record of the move wins", async () => {
    const e = await make();
    const r = await mcp(p.mcpToken, "update_entry", {
      collection: "tickets",
      id: e.id,
      data: { status: "resolved", resolution: "wontfix" },
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.data.resolution, "fixed", "the transition's stamp beats the client's claim");
  });

  it("a NON-transition update does not stamp; a same-state echo does not stamp", async () => {
    const e = await make();
    const plain = await mcp(p.mcpToken, "update_entry", {
      collection: "tickets", id: e.id, data: { title: "renamed" },
    });
    assert.ok(plain.ok, plain.errorText);
    assert.ok(!("resolved_at" in plain.value.data), "no move, no stamp");
    const echo = await mcp(p.mcpToken, "update_entry", {
      collection: "tickets", id: e.id, data: { status: "open", title: "echoed" },
    });
    assert.ok(echo.ok, echo.errorText);
    assert.ok(!("resolved_at" in echo.value.data), "same-state no-op must not stamp (WP-4 semantics)");
  });

  it("the CAS path stamps too — update_entry_if with the transition applies the branch's set", async () => {
    const e = await make();
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "tickets",
      id: e.id,
      if: [{ field: "title", op: "eq", value: "t" }],
      data: { status: "resolved" },
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.data.resolution, "fixed");
    assert.ok(Number.isFinite(Date.parse(r.value.data.resolved_at)), "CAS transition stamped resolved_at");
  });

  it("the stamp is in changedFields — the feed and versions know the field moved", async () => {
    const e = await make();
    await mcp(p.mcpToken, "update_entry", { collection: "tickets", id: e.id, data: { status: "resolved" } });
    // The feed holds rows back ~2s so the bigserial cursor stays monotone — poll.
    const row = await waitFor(async () => {
      const feed = await mcp(p.mcpToken, "get_changes", { collection: "tickets" });
      return feed.ok
        ? (feed.value.changes.filter((c) => c.id === e.id && c.kind === "updated").pop() ?? null)
        : null;
    });
    assert.ok(row, "expected the update in the feed");
    assert.ok(row.changedFields.includes("resolved_at"), `changedFields: ${row.changedFields}`);
    assert.ok(row.changedFields.includes("resolution"));
  });

  it("define-time refusals: every illegal set is named at define, never at transition time", async () => {
    const base = [
      { name: "title", label: "T", type: "text", required: true },
      { name: "s", label: "S", type: "enum", options: ["a", "b"] },
      { name: "when_done", label: "W", type: "date" },
      { name: "kind", label: "K", type: "enum", options: ["x", "y"] },
      { name: "slug", label: "Sl", type: "text", computed: { fn: "slugify", from: "title" } },
      { name: "secret", label: "Sec", type: "text", writeOnly: true },
    ];
    const wf = (set) => ({
      field: "s", initial: "a",
      transitions: [{ from: "a", to: "b", actors: ["mcp"], set }],
    });
    const cases = [
      [{ nope: "now" }, /not a field/],
      [{ s: { value: "b" } }, /workflow field/],
      [{ slug: { value: "x" } }, /computed/],
      [{ secret: { value: "x" } }, /write-only/],
      [{ title: "now" }, /"now" needs a date field/],
      [{ title: null }, /required/],
      [{ kind: { value: "zzz" } }, /not a valid value/],
      [{}, /must not be empty/],
    ];
    for (const [set, re] of cases) {
      const r = await mcp(p.mcpToken, "define_collection", { name: "bad_set", fields: base, workflow: wf(set) });
      assert.equal(r.ok, false, `must refuse set=${JSON.stringify(set)}`);
      assert.match(r.errorText, re, `refusal must name the reason for ${JSON.stringify(set)}: ${r.errorText}`);
    }
  });

  it("POSITIVE CONTROL for the parser: `set` survives the zod layer (the `when` lesson)", async () => {
    // The D2 handoff's hard lesson: the workflow `when` clause was once accepted
    // and SILENTLY STRIPPED by the parser. Prove `set` round-trips: describe the
    // collection and find the set in the stored transition.
    const d = await mcp(p.mcpToken, "describe_collection", { name: "tickets" });
    assert.ok(d.ok, d.errorText);
    const t = d.value.workflow.transitions.find((x) => x.to === "resolved");
    assert.deepEqual(
      t.set,
      { resolved_at: "now", resolution: { value: "fixed" } },
      "set must be STORED, not silently stripped — grep counted before believing",
    );
  });
});
