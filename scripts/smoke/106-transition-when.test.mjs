import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// D2 — workflow transitions gate on WHO but never on WHAT.
//
// "May not go live without a creative" had to become a required field, which
// then blocked saving a draft: the constraint landed at every save instead of
// at the one transition that cares. `when` puts it at the right moment.

describe("D2 — transition preconditions", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("transition-when");
    await mcp(p.mcpToken, "define_collection", {
      name: "campaigns",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "creative", label: "C", type: "text" },
        { name: "budget", label: "B", type: "number" },
        { name: "status", label: "S", type: "enum", options: ["draft", "live", "archived"] },
      ],
      workflow: {
        field: "status",
        initial: "draft",
        transitions: [
          {
            from: "draft",
            to: "live",
            actors: ["mcp"],
            when: [{ field: "creative", op: "exists", value: true }],
          },
          // A second route to the SAME state with a DIFFERENT precondition —
          // the case that breaks a naive flatten-and-AND implementation.
          {
            from: "archived",
            to: "live",
            actors: ["mcp"],
            when: [{ field: "budget", op: "gt", value: 0 }],
          },
          { from: ["draft", "live"], to: "archived", actors: ["mcp"] },
        ],
      },
    });
  });
  after(() => p.destroy());

  const make = async (data) => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "campaigns", data });
    assert.ok(r.ok, r.errorText);
    return r.value.id;
  };
  const move = (id, status) =>
    mcp(p.mcpToken, "update_entry", { collection: "campaigns", id, data: { status } });

  it("THE POINT: a draft SAVES without the creative — the old workaround could not", async () => {
    const id = await make({ title: "no creative yet" });
    const r = await mcp(p.mcpToken, "update_entry", {
      collection: "campaigns", id, data: { title: "still drafting" },
    });
    assert.ok(r.ok, `a required field would have blocked this: ${r.errorText}`);
  });

  it("...but it cannot GO LIVE without one, and the error names the requirement", async () => {
    const id = await make({ title: "unfinished" });
    const r = await move(id, "live");
    assert.equal(r.ok, false);
    assert.match(r.errorText, /creative/, "an unmet precondition the caller cannot see is one they cannot fix");
    assert.match(r.errorText, /to be set/);
  });

  it("...and once the creative exists, it goes live", async () => {
    const id = await make({ title: "ready", creative: "hero.png" });
    const r = await move(id, "live");
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.data.status, "live");
  });

  it("EACH BRANCH keeps its OWN precondition — they are not ANDed together", async () => {
    // archived -> live requires budget > 0, NOT a creative. Flattening the
    // branches would demand both and enforce a rule nobody wrote.
    const id = await make({ title: "revived", budget: 500 });
    await move(id, "archived");
    const r = await move(id, "live");
    assert.ok(r.ok, `archived->live must use ITS OWN when clause: ${r.errorText}`);
  });

  it("...and that branch still enforces its own rule", async () => {
    const id = await make({ title: "broke", budget: 0 });
    await move(id, "archived");
    const r = await move(id, "live");
    assert.equal(r.ok, false);
    assert.match(r.errorText, /budget/);
  });

  it("a transition with NO when clause is unaffected", async () => {
    const id = await make({ title: "plain" });
    const r = await move(id, "archived");
    assert.ok(r.ok, r.errorText);
  });

  it("update_entry_if enforces it too — the CAS path is not a way around it", async () => {
    const id = await make({ title: "cas" });
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "campaigns", id, data: { status: "live" },
    });
    assert.equal(r.ok, false, "the atomic path must respect the precondition");
  });

  it("a when clause naming an unknown field is refused at DEFINE time", async () => {
    // Failing at the moment of a transition would be the worst time to learn.
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad_wf",
      fields: [{ name: "s", label: "S", type: "enum", options: ["a", "b"] }],
      workflow: {
        field: "s",
        initial: "a",
        transitions: [{ from: "a", to: "b", when: [{ field: "nope", op: "exists", value: true }] }],
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /nope/);
  });
});
