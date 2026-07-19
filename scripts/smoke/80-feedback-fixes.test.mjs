import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql } from "./helpers.mjs";

// Three feedback-wall fixes (items #11, #19, #18):
//  #11 omitting workflow on redefine must require confirm (silent state-machine
//      removal was destroying live rules)
//  #19 a relation to a just-created collection must NOT fail on stale cache, and
//      a genuinely-missing target is E_VALIDATION not E_INTERNAL
//  #18 create_entry must accept explicit null on optional fields (= not provided)
describe("feedback fixes: workflow-drop / stale-relation / create-null", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("feedback-fixes");
  });

  it("#19: a relation to a collection created MOMENTS earlier resolves (no stale-cache fail)", async () => {
    const a = await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [{ name: "name", label: "N", type: "text", required: true }],
    });
    assert.ok(a.ok, a.errorText);
    // Immediately define a collection relating to it — the exact repro.
    const posts = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "author", label: "A", type: "relation", targetCollection: "authors", labelField: "name" },
      ],
    });
    assert.ok(posts.ok, `relation to just-created collection must resolve: ${posts.errorText}`);
  });

  it("#19: a genuinely unknown relation target is E_VALIDATION, not E_INTERNAL", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      fields: [{ name: "x", label: "X", type: "relation", targetCollection: "does_not_exist", labelField: "name" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /unknown collection "does_not_exist".*create/i, r.errorText);
    assert.doesNotMatch(r.errorText, /E_INTERNAL/i);
  });

  it("#11: redefining a workflow collection WITHOUT resending workflow needs confirm", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [{ name: "status", label: "S", type: "enum", options: ["open", "closed"] }],
      workflow: {
        field: "status",
        initial: "open",
        transitions: [{ from: "open", to: "closed", actors: ["mcp", "admin"] }],
      },
    });
    assert.ok(def.ok, def.errorText);

    // Additive change that FORGETS to resend workflow → must be GATED (requires
    // confirm), not silently applied. Response is ok with requiresConfirmation
    // (same shape as a dropped-field plan), NOT an error.
    const drop = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "status", label: "S", type: "enum", options: ["open", "closed"] },
        { name: "note", label: "Note", type: "text" },
      ],
    });
    assert.ok(drop.value?.requiresConfirmation, `silent workflow removal must be gated: ${JSON.stringify(drop.value) ?? drop.errorText}`);
    // The workflow is STILL stored — the gate protected it.
    const [still] = await sql`SELECT workflow IS NOT NULL AS has_wf FROM collections WHERE project_id = ${p.id} AND name = 'tickets'`;
    assert.equal(still.has_wf, true, "workflow must NOT have been removed by the un-confirmed redefine");

    // Resending the workflow (keeping it) applies cleanly, no confirm needed.
    const keep = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "status", label: "S", type: "enum", options: ["open", "closed"] },
        { name: "note", label: "Note", type: "text" },
      ],
      workflow: {
        field: "status",
        initial: "open",
        transitions: [{ from: "open", to: "closed", actors: ["mcp", "admin"] }],
      },
    });
    assert.ok(keep.ok, `resending the workflow keeps it: ${keep.errorText}`);

    // Deliberate removal WITH confirm succeeds.
    const remove = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "status", label: "S", type: "enum", options: ["open", "closed"] },
        { name: "note", label: "Note", type: "text" },
      ],
      confirm: true,
    });
    assert.ok(remove.ok, `confirmed removal applies: ${remove.errorText}`);
  });

  it("#18: create_entry accepts explicit null on optional fields (= not provided)", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "body", label: "B", type: "text" },
        { name: "amount", label: "Amt", type: "number" },
      ],
    });
    assert.ok(def.ok, def.errorText);
    // The natural client pattern that used to fail: {x: value || null}.
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "notes",
      data: { title: "Hi", body: null, amount: null },
    });
    assert.ok(c.ok, `explicit null on optional fields must be accepted: ${c.errorText}`);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "notes", id: c.value.id });
    const d = got.value.data ?? got.value;
    assert.equal(d.title, "Hi");
    assert.equal(d.body, undefined, "null optional stored as absent, not null");

    // A null on a REQUIRED field still fails — but as the clear 'required' error.
    const bad = await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { title: null } });
    assert.equal(bad.ok, false);
    assert.match(bad.errorText, /required|title/i, bad.errorText);
  });
});
