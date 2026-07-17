import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql, collectionId } from "./helpers.mjs";

// Track 4a: total-stored-bytes ceiling (caps.ts assertDataBytes). The entries
// cap bounds row COUNT; this bounds row FAT — without it an at-cap project
// could inflate every row toward the body limit (update-inflation) or store
// 1k × 1 MiB bodies in a free sandbox.
//
// The check is CACHED ~60s, so the blob is seeded (server-side SQL — nothing
// big crosses the wire) BEFORE the first app write: the first cache fill then
// sees the over-cap total. ~160 MB of md5 hex ≫ the 50 MB sandbox cap even
// after TOAST compression.
describe("data-bytes cap (Track 4a)", () => {
  let p, control;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("data-bytes-cap");
    control = await createEphemeralProject("data-bytes-control"); // plan NULL — uncapped

    // BEFORE any MCP call: projectPlan() is unstable_cache'd (tag-only) — the
    // first cap check caches whatever plan it sees, so 'sandbox' must be set
    // before define_collection's collection-cap check fills that cache.
    await sql`UPDATE projects SET plan = 'sandbox' WHERE id = ${p.id}`;

    for (const proj of [p, control]) {
      const def = await mcp(proj.mcpToken, "define_collection", {
        name: "posts",
        fields: [{ name: "title", label: "Title", type: "text", required: true, publicRead: true }],
      });
      assert.ok(def.ok, def.errorText);
    }

    // Seed: one small pre-existing row (the update-block target) + ~160 MB of
    // low-compressibility hex spread over ~32 rows — all generated in Postgres.
    const cid = await collectionId(p.id, "posts");
    assert.ok(cid);
    await sql`INSERT INTO entries (project_id, collection_id, data)
      VALUES (${p.id}, ${cid}, ${JSON.stringify({ title: "small" })}::jsonb)`;
    await sql`INSERT INTO entries (project_id, collection_id, data)
      SELECT ${p.id}, ${cid}, jsonb_build_object('title', 'blob', 'payload', string_agg(md5(g::text), ''))
      FROM generate_series(1, 5000000) g
      GROUP BY g / 160000`;
  });

  after(async () => {
    await p?.destroy();
    await control?.destroy();
  });

  it("create is blocked once stored bytes exceed the sandbox cap", async () => {
    const res = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "one more" } });
    assert.equal(res.ok, false);
    assert.match(res.errorText, /cap reached: stored content/i, res.errorText);
  });

  it("update-inflation is blocked too (row count never moves)", async () => {
    const [row] = await sql`SELECT id FROM entries
      WHERE project_id = ${p.id} AND data->>'title' = 'small' LIMIT 1`;
    assert.ok(row);
    const res = await mcp(p.mcpToken, "update_entry", {
      collection: "posts",
      id: row.id,
      data: { title: "grow attempt" },
    });
    assert.equal(res.ok, false);
    assert.match(res.errorText, /cap reached: stored content/i, res.errorText);
  });

  it("bulk create is blocked", async () => {
    const res = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [{ title: "a" }, { title: "b" }],
    });
    assert.equal(res.ok, false);
    assert.match(res.errorText, /cap reached: stored content/i, res.errorText);
  });

  it("a plan-NULL (legacy/operator) project is unaffected", async () => {
    const res = await mcp(control.mcpToken, "create_entry", { collection: "posts", data: { title: "fine" } });
    assert.ok(res.ok, res.errorText);
  });
});
