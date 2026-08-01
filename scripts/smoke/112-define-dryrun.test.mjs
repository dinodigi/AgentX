import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// DX-7 (wall 61f9b82e, xvibe) — dryRun on define_collection: the full plan,
// nothing applied. transact set the precedent; this is the schema half of an
// agent's plan mode: propose, show the diff, then apply.

describe("DX-7 — define_collection dryRun", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("define-dryrun");
  });
  after(() => p.destroy());

  it("NEW collection: reports wouldCreate and creates NOTHING", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      dryRun: true,
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "body", label: "B", type: "richtext", publicRead: true },
      ],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.dryRun, true);
    assert.equal(r.value.applied, false);
    assert.equal(r.value.wouldCreate, true);
    assert.equal(r.value.fieldCount, 2);
    // THE guarantee: nothing exists afterwards.
    const list = await mcp(p.mcpToken, "list_collections", {});
    assert.ok(list.ok, list.errorText);
    assert.ok(!list.value.some((c) => c.name === "articles"), "dryRun must not create the collection");
  });

  it("dryRun still VALIDATES — a bad schema fails the same way the real call would", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      dryRun: true,
      fields: [{ name: "x", label: "X", type: "enum" }], // enum without options
    });
    assert.equal(r.ok, false, "validation must not be skipped in dry mode");
    assert.match(r.errorText, /options/);
  });

  it("EXISTING collection: the dry diff equals the destructive-confirm plan, and applies nothing", async () => {
    const mk = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "body", label: "B", type: "richtext", publicRead: true },
        { name: "views", label: "V", type: "number" },
      ],
    });
    assert.ok(mk.ok, mk.errorText);
    await mcp(p.mcpToken, "create_entry", {
      collection: "articles", data: { title: "t", views: 3 },
    });

    // A destructive redefine: drop `views`, add `author`.
    const proposal = {
      name: "articles",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "body", label: "B", type: "richtext", publicRead: true },
        { name: "author", label: "A", type: "text" },
      ],
    };
    const dry = await mcp(p.mcpToken, "define_collection", { ...proposal, dryRun: true });
    assert.ok(dry.ok, dry.errorText);
    assert.equal(dry.value.dryRun, true);
    assert.equal(dry.value.wouldRequireConfirmation, true, "the plan must SAY the real call needs confirm");
    assert.deepEqual(dry.value.diff.removed, ["views"]);
    assert.deepEqual(dry.value.diff.added, ["author"]);
    assert.equal(dry.value.diff.affectedEntries, 1, "the diff counts real rows, like the confirm plan");

    // The confirm-gate plan for the SAME proposal must be the same diff — one
    // planner, two exits. (This is the "plan equals plan" assertion the sprint
    // doc demands.)
    const gated = await mcp(p.mcpToken, "define_collection", proposal);
    assert.ok(gated.ok, gated.errorText);
    assert.equal(gated.value.requiresConfirmation, true);
    assert.deepEqual(gated.value.plan.removed, dry.value.diff.removed);
    assert.deepEqual(gated.value.plan.added, dry.value.diff.added);
    assert.equal(gated.value.plan.affectedEntries, dry.value.diff.affectedEntries);

    // And neither call changed the stored schema.
    const desc = await mcp(p.mcpToken, "describe_collection", { name: "articles" });
    assert.ok(desc.value.fields.some((f) => f.name === "views"), "views must still exist");
    assert.ok(!desc.value.fields.some((f) => f.name === "author"), "author must not exist yet");
  });

  it("a NON-destructive dry run reports the additive diff without demanding confirm", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      dryRun: true,
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "body", label: "B", type: "richtext", publicRead: true },
        { name: "views", label: "V", type: "number" },
        { name: "tags", label: "Tg", type: "array", item: { type: "text" } },
      ],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.diff.added, ["tags"]);
    assert.ok(!r.value.wouldRequireConfirmation, "additive change needs no confirm — the plan must not cry wolf");
    assert.match(r.value.hint, /Re-send without dryRun/);
  });

  it("dry run carries the SAME coaching the real call gives (accessNote, WP-9)", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "gated_preview",
      dryRun: true,
      fields: [
        { name: "title", label: "T", type: "text", publicRead: true },
        { name: "notes", label: "N", type: "text" },
      ],
      access: { read: { claim: "role", equals: "staff" } },
    });
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.accessNote ?? "", /notes/, "the plan should coach BEFORE the mistake ships");
  });

  it("addFields composes with dryRun — preview an append without racing anyone", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      dryRun: true,
      addFields: [{ name: "subtitle", label: "S", type: "text" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.dryRun, true);
    assert.deepEqual(r.value.diff.added, ["subtitle"]);
    const desc = await mcp(p.mcpToken, "describe_collection", { name: "articles" });
    assert.ok(!desc.value.fields.some((f) => f.name === "subtitle"), "preview must not append");
  });
});
