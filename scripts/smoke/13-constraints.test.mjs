import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

describe("field constraints: unique, min/max, requiredIf", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("constraints");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "products",
      fields: [
        { name: "slug", label: "Slug", type: "text", required: true, unique: true },
        { name: "title", label: "Title", type: "text", min: 3 },
        { name: "price", label: "Price", type: "number", min: 0, max: 1000 },
        { name: "status", label: "Status", type: "enum", options: ["draft", "rejected"] },
        { name: "reason", label: "Reason", type: "text", requiredIf: { field: "status", equals: "rejected" } },
      ],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("unique: duplicate values rejected on create, update, and bulk", async () => {
    const first = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "alpha" },
    });
    assert.ok(first.ok, first.errorText);

    const dup = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "alpha" },
    });
    assert.ok(!dup.ok && /slug: value already exists/.test(dup.errorText), dup.errorText);

    const second = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "beta" },
    });
    assert.ok(second.ok, second.errorText);
    const patchDup = await mcp(p.mcpToken, "update_entry", {
      collection: "products",
      id: second.value.id,
      data: { slug: "alpha" },
    });
    assert.ok(!patchDup.ok && /unique/.test(patchDup.errorText), patchDup.errorText);

    const bulk = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "products",
      entries: [{ slug: "gamma" }, { slug: "alpha" }],
    });
    assert.ok(!bulk.ok && /slug: value already exists/.test(bulk.errorText), bulk.errorText);
  });

  it("min/max: number value bounds and text length bounds", async () => {
    const low = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "p1", price: -5 },
    });
    assert.ok(!low.ok && /price: must be >= 0/.test(low.errorText), low.errorText);

    const high = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "p2", price: 2000 },
    });
    assert.ok(!high.ok && /price: must be <= 1000/.test(high.errorText), high.errorText);

    const short = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "p3", title: "ab" },
    });
    assert.ok(!short.ok && /title: must be at least 3 characters/.test(short.errorText), short.errorText);

    const ok = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "p4", title: "abc", price: 500 },
    });
    assert.ok(ok.ok, ok.errorText);
  });

  it("requiredIf: enforced only when the enum matches", async () => {
    const missing = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "r1", status: "rejected" },
    });
    assert.ok(!missing.ok && /reason: required when status = "rejected"/.test(missing.errorText), missing.errorText);

    const withReason = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "r2", status: "rejected", reason: "broken" },
    });
    assert.ok(withReason.ok, withReason.errorText);

    const draft = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "r3", status: "draft" },
    });
    assert.ok(draft.ok, draft.errorText);
  });

  it("meta-validation rejects misplaced constraints", async () => {
    const uniqueBool = await mcp(p.mcpToken, "define_collection", {
      name: "bad1",
      fields: [{ name: "on", label: "On", type: "boolean", unique: true }],
    });
    assert.ok(!uniqueBool.ok && /unique is only valid/.test(uniqueBool.errorText), uniqueBool.errorText);

    const minDate = await mcp(p.mcpToken, "define_collection", {
      name: "bad2",
      fields: [{ name: "when", label: "When", type: "date", min: 1 }],
    });
    assert.ok(!minDate.ok && /min\/max are only valid/.test(minDate.errorText), minDate.errorText);

    const badRef = await mcp(p.mcpToken, "define_collection", {
      name: "bad3",
      fields: [
        { name: "a", label: "A", type: "text", requiredIf: { field: "b", equals: "x" } },
        { name: "b", label: "B", type: "text" },
      ],
    });
    assert.ok(!badRef.ok && /sibling enum field/.test(badRef.errorText), badRef.errorText);

    const inverted = await mcp(p.mcpToken, "define_collection", {
      name: "bad4",
      fields: [{ name: "n", label: "N", type: "number", min: 10, max: 1 }],
    });
    assert.ok(!inverted.ok && /min must be <= max/.test(inverted.errorText), inverted.errorText);
  });

  it("enabling unique on existing duplicates fails; disabling re-allows them", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text" }],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "tags",
      entries: [{ name: "dup" }, { name: "dup" }],
    });

    const enable = await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text", unique: true }],
    });
    assert.ok(!enable.ok && /duplicate values/.test(enable.errorText), enable.errorText);

    // Dedupe, enable, verify enforcement, then disable and re-allow.
    const rows = await mcp(p.mcpToken, "query_entries", {
      collection: "tags",
      where: [{ field: "name", op: "eq", value: "dup" }],
    });
    await mcp(p.mcpToken, "delete_entry", { collection: "tags", id: rows.value.entries[0].id });

    const enable2 = await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text", unique: true }],
    });
    assert.ok(enable2.ok, enable2.errorText);
    const blocked = await mcp(p.mcpToken, "create_entry", { collection: "tags", data: { name: "dup" } });
    assert.ok(!blocked.ok && /unique/.test(blocked.errorText), blocked.errorText);

    const disable = await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text" }],
    });
    assert.ok(disable.ok, disable.errorText);
    const allowed = await mcp(p.mcpToken, "create_entry", { collection: "tags", data: { name: "dup" } });
    assert.ok(allowed.ok, allowed.errorText);
  });
});
