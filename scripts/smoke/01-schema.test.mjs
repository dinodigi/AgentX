import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

describe("schema registry", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("schema");
  });
  after(() => p.destroy());

  it("defines, lists, and describes a collection", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "status", label: "Status", type: "enum", options: ["draft", "live"] },
      ],
    });
    assert.ok(def.ok, def.errorText);

    const list = await mcp(p.mcpToken, "list_collections", {});
    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].name, "posts");

    const desc = await mcp(p.mcpToken, "describe_collection", { name: "posts" });
    assert.equal(desc.value.fields.length, 2);
  });

  it("rejects an invented field type", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      fields: [{ name: "x", label: "X", type: "geolocation" }],
    });
    assert.ok(!r.ok && /Invalid enum value/.test(r.errorText));
  });

  it("rejects a relation to an unknown collection", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad2",
      fields: [{ name: "x", label: "X", type: "relation", targetCollection: "nope", labelField: "y" }],
    });
    assert.ok(!r.ok && /unknown collection/.test(r.errorText));
  });

  it("rejects reserved collection slugs", async () => {
    for (const name of ["settings", "api", "connectors", "assets"]) {
      const r = await mcp(p.mcpToken, "define_collection", {
        name,
        fields: [{ name: "x", label: "X", type: "text" }],
      });
      assert.ok(!r.ok && /reserved/.test(r.errorText), `${name} should be reserved`);
    }
  });

  it("destructive redefine returns a plan and requires confirm", async () => {
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "t", status: "draft" } });
    const noConfirm = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "Title", type: "text", required: true, publicRead: true }],
    });
    assert.ok(noConfirm.ok && noConfirm.value.requiresConfirmation, "expected plan");
    assert.deepEqual(noConfirm.value.plan.removed, ["status"]);
    assert.equal(noConfirm.value.plan.affectedEntries, 1);

    const confirmed = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "Title", type: "text", required: true, publicRead: true }],
      confirm: true,
    });
    assert.ok(confirmed.ok && confirmed.value.ok, "confirm should apply");
  });

  it("delete_collection: relation block, plan, confirmed delete", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [{ name: "name", label: "Name", type: "text" }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "books",
      fields: [{ name: "author", label: "Author", type: "relation", targetCollection: "authors", labelField: "name" }],
    });
    const blocked = await mcp(p.mcpToken, "delete_collection", { name: "authors", confirm: true });
    assert.ok(!blocked.ok && /relation fields still target/.test(blocked.errorText));

    const plan = await mcp(p.mcpToken, "delete_collection", { name: "books" });
    assert.ok(plan.ok && plan.value.requiresConfirmation);

    const del = await mcp(p.mcpToken, "delete_collection", { name: "books", confirm: true });
    assert.ok(del.ok && del.value.deleted === "books");
  });
});
