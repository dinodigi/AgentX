import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

describe("rename migration: field renames backfill data", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("rename");
    await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        { name: "headline", label: "Headline", type: "text", required: true, publicRead: true },
        { name: "body", label: "Body", type: "richtext" },
      ],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "articles",
      entries: [
        { headline: "First", body: "<p>one</p>" },
        { headline: "Second" },
      ],
    });
  });
  after(() => p.destroy());

  it("rename moves data, needs no confirm, and reports in the diff", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "body", label: "Body", type: "richtext" },
      ],
      renames: [{ from: "headline", to: "title" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.ok(r.value.ok, "rename must apply without confirm");
    assert.deepEqual(r.value.changes.renamed, [{ from: "headline", to: "title" }]);
    assert.deepEqual(r.value.changes.removed, []);
    assert.deepEqual(r.value.changes.added, []);

    const rows = await mcp(p.mcpToken, "query_entries", {
      collection: "articles",
      orderBy: { field: "title", dir: "asc" },
    });
    assert.deepEqual(rows.value.entries.map((e) => e.data.title), ["First", "Second"]);
    assert.ok(rows.value.entries.every((e) => !("headline" in e.data)), "old key must be gone");
    assert.equal(rows.value.entries[0].data.body, "<p>one</p>"); // untouched fields survive
  });

  it("renamed public field serves under the new name via delivery", async () => {
    const { delivery } = await import("./helpers.mjs");
    const r = await delivery(p.deliveryToken, "/articles?sort=title:asc");
    assert.equal(r.status, 200);
    assert.equal(r.json.data[0].title, "First");
    assert.ok(!("headline" in r.json.data[0]));
  });

  it("bad renames get fix hints; without renames a rename is destructive", async () => {
    const unknownFrom = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        { name: "caption", label: "Caption", type: "text", required: true },
        { name: "body", label: "Body", type: "richtext" },
      ],
      renames: [{ from: "nope", to: "caption" }],
    });
    assert.ok(!unknownFrom.ok && /not a field of/.test(unknownFrom.errorText), unknownFrom.errorText);

    const retype = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        { name: "words", label: "Words", type: "number" },
        { name: "body", label: "Body", type: "richtext" },
      ],
      renames: [{ from: "title", to: "words" }],
    });
    assert.ok(!retype.ok && /cannot retype/.test(retype.errorText), retype.errorText);

    const missingTo = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [{ name: "body", label: "Body", type: "richtext" }],
      renames: [{ from: "title", to: "caption" }],
    });
    assert.ok(!missingTo.ok && /must be a field in the new definition/.test(missingTo.errorText), missingTo.errorText);

    const uniqueSneak = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        { name: "slug", label: "Slug", type: "text", required: true, unique: true },
        { name: "body", label: "Body", type: "richtext" },
      ],
      renames: [{ from: "title", to: "slug" }],
    });
    assert.ok(!uniqueSneak.ok && /rename first, then enable unique/.test(uniqueSneak.errorText), uniqueSneak.errorText);

    // The old way — same shape change WITHOUT renames — still demands confirm.
    const plain = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [
        { name: "caption", label: "Caption", type: "text", required: true },
        { name: "body", label: "Body", type: "richtext" },
      ],
    });
    assert.ok(plain.ok && plain.value.requiresConfirmation, "drop+add must still gate on confirm");
    assert.deepEqual(plain.value.plan.removed, ["title"]);
  });

  it("renaming a unique field carries the constraint and its index", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "coupons",
      fields: [{ name: "code", label: "Code", type: "text", unique: true }],
    });
    await mcp(p.mcpToken, "create_entry", { collection: "coupons", data: { code: "SAVE10" } });

    const r = await mcp(p.mcpToken, "define_collection", {
      name: "coupons",
      fields: [{ name: "voucher", label: "Voucher", type: "text", unique: true }],
      renames: [{ from: "code", to: "voucher" }],
    });
    assert.ok(r.ok && r.value.ok, r.errorText);

    const dup = await mcp(p.mcpToken, "create_entry", {
      collection: "coupons",
      data: { voucher: "SAVE10" },
    });
    assert.ok(!dup.ok && /voucher: value already exists/.test(dup.errorText), dup.errorText);
  });
});
