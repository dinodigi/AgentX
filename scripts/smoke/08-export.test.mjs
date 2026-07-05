import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

describe("data export", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("export");
    await mcp(p.mcpToken, "define_collection", {
      name: "contacts",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "note", label: "Note", type: "text" },
      ],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "contacts",
      entries: [
        { name: "Plain Row" },
        { name: 'Tricky "quoted", comma', note: "line1\nline2" },
      ],
    });
  });
  after(() => p.destroy());

  it("json export returns ids + raw data with truncated flag", async () => {
    const r = await mcp(p.mcpToken, "export_entries", { collection: "contacts" });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.rowCount, 2);
    assert.equal(r.value.truncated, false);
    const names = r.value.rows.map((x) => x.data.name).sort();
    assert.ok(names.includes("Plain Row"));
    assert.ok(r.value.rows[0].id, "rows carry ids for re-import mapping");
  });

  it("csv export escapes quotes, commas, and newlines", async () => {
    const r = await mcp(p.mcpToken, "export_entries", { collection: "contacts", format: "csv" });
    assert.ok(r.ok, r.errorText);
    const csv = r.value.csv;
    assert.ok(csv.startsWith("id,name,note,createdAt,updatedAt"));
    assert.ok(csv.includes('"Tricky ""quoted"", comma"'), "quotes doubled, cell wrapped");
    assert.ok(csv.includes('"line1\nline2"'), "newline cell wrapped");
  });

  it("admin download route requires an operator session", async () => {
    const res = await fetch(
      `${BASE}/api/admin/export-entries?projectId=${p.id}&collection=contacts&format=csv`,
    );
    assert.equal(res.status, 401);
  });

  it("unknown collection is a clean error", async () => {
    const r = await mcp(p.mcpToken, "export_entries", { collection: "nope" });
    assert.ok(!r.ok && /not found/.test(r.errorText));
  });
});
