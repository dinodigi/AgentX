import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// v2 Track 1b: the block library — define a block once (define_block),
// reference it by NAME from any collection; define_collection materializes the
// def. Editing a used block is Terraform-style: plan + confirm, then
// re-materialize into every using collection. Delete refuses while in use.
describe("block library (declare a block as a template)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("block-library");
    const def = await mcp(p.mcpToken, "define_block", {
      name: "hero",
      label: "Hero",
      fields: [{ name: "heading", label: "H", type: "text", required: true }],
    });
    assert.ok(def.value?.applied, def.errorText ?? JSON.stringify(def.value));
  });

  it("a string ref materializes the library def (usable end-to-end)", async () => {
    const c = await mcp(p.mcpToken, "define_collection", {
      name: "pages",
      fields: [{ name: "body", label: "Body", type: "array", publicRead: true, blocks: ["hero"] }],
    });
    assert.ok(c.ok, c.errorText);
    const e = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { body: [{ _type: "hero", heading: "Hi" }] },
    });
    assert.ok(e.ok, e.errorText);
    const r = await delivery(p.deliveryToken, "/pages");
    assert.equal(r.json.data[0].body[0].heading, "Hi");
    assert.equal(r.json.data[0].body[0]._type, "hero");
  });

  it("list_blocks shows usage", async () => {
    const r = await mcp(p.mcpToken, "list_blocks", {});
    assert.ok(r.ok, r.errorText);
    const hero = r.value.find((b) => b.name === "hero");
    assert.deepEqual(hero.usedBy, ["pages"]);
  });

  it("an unknown ref errors with the catalog", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      fields: [{ name: "b", label: "B", type: "array", blocks: ["nope"] }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /unknown library block "nope".*hero/i, r.errorText);
  });

  it("editing a USED block: plan + confirm, then re-materializes into users", async () => {
    const newFields = [
      { name: "heading", label: "H", type: "text", required: true },
      { name: "subtitle", label: "S", type: "text" },
    ];
    const plan = await mcp(p.mcpToken, "define_block", { name: "hero", label: "Hero v2", fields: newFields });
    assert.ok(plan.ok, plan.errorText);
    assert.equal(plan.value.applied, false);
    assert.deepEqual(plan.value.usedBy, ["pages"]);

    const applied = await mcp(p.mcpToken, "define_block", {
      name: "hero",
      label: "Hero v2",
      fields: newFields,
      confirm: true,
    });
    assert.ok(applied.ok, applied.errorText);
    assert.equal(applied.value.applied, true);

    // New shape is live in the using collection: subtitle now writable.
    const e = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { body: [{ _type: "hero", heading: "Hi2", subtitle: "there" }] },
    });
    assert.ok(e.ok, e.errorText);
  });

  it("a block edit that would break a using collection rejects all-or-nothing", async () => {
    // One-level rule: a repeater-of-groups inside a block is invalid in the
    // array context the block lives in — must reject naming the collection.
    const r = await mcp(p.mcpToken, "define_block", {
      name: "hero",
      label: "Hero v3",
      confirm: true,
      fields: [
        {
          name: "slides",
          label: "Slides",
          type: "array",
          item: { type: "group", fields: [{ name: "t", label: "T", type: "text" }] },
        },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /too deep|related collection/i, r.errorText);
  });

  it("delete refuses while in use, succeeds when unused", async () => {
    const used = await mcp(p.mcpToken, "delete_block", { name: "hero" });
    assert.equal(used.ok, false);
    assert.match(used.errorText, /still used by: pages/i);

    const spare = await mcp(p.mcpToken, "define_block", {
      name: "spare",
      label: "Spare",
      fields: [{ name: "x", label: "X", type: "text" }],
    });
    assert.ok(spare.value?.applied, spare.errorText);
    const gone = await mcp(p.mcpToken, "delete_block", { name: "spare" });
    assert.ok(gone.ok, gone.errorText);
    assert.equal(gone.value.deleted, true);
  });
});
