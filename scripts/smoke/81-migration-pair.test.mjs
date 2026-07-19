import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// The migration pair (feedback #12 + #6):
//  #12 workflow import escape hatch — allowExplicitWorkflowState lets historical
//      records load at their REAL states (audit-stamped) instead of being forced
//      to `initial`; without the flag the old rejection stands (and teaches it).
//  #6  export_entries keyset cursor — paging to nextCursor=null is a complete,
//      exact export; the old 5000-row cap turned backup into sampling.
describe("migration pair: workflow escape hatch (#12) + export cursor (#6)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("migration-pair");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [
        { name: "who", label: "Who", type: "text", required: true },
        // "kit" is deliberately an orphan option — no transition routes to it,
        // exactly like a legacy status a migration must still carry over.
        { name: "status", label: "S", type: "enum", options: ["new", "contacted", "closed", "kit"] },
      ],
      workflow: {
        field: "status",
        initial: "new",
        transitions: [
          { from: "new", to: "contacted", actors: ["mcp", "admin"] },
          { from: "contacted", to: "closed", actors: ["mcp", "admin"] },
        ],
      },
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("#12: explicit non-initial state WITHOUT the flag is rejected — and the error teaches the hatch", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "leads",
      data: { who: "A", status: "closed" },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /must start at "new"/);
    assert.match(r.errorText, /allowExplicitWorkflowState/, "rejection should teach the migration flag");
  });

  it("#12: create_entry with the flag imports at the real state and audit-stamps the use", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "leads",
      data: { who: "B", status: "closed" },
      allowExplicitWorkflowState: true,
    });
    assert.ok(r.ok, r.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "leads", id: r.value.id });
    assert.equal(got.value.data.status, "closed", "imported at its real state");

    // Audit writes are deferred — poll briefly for the stamped actor.
    let stamped = null;
    for (let i = 0; i < 12 && !stamped; i++) {
      const log = await mcp(p.mcpToken, "get_audit_log", { collection: "leads", entryId: r.value.id });
      stamped = (log.value?.audit ?? []).find((a) => a.action === "create") ?? null;
      if (!stamped) await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(stamped, "create audit row should appear");
    assert.equal(stamped.actor?.type, "mcp");
    assert.equal(stamped.actor?.explicitWorkflowState, true, "escape-hatch use must be audit-visible");
  });

  it("#12: bulk_create_entries with the flag loads mixed historical states (orphan option included)", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "leads",
      entries: [
        { who: "C", status: "closed" },
        { who: "D", status: "kit" }, // orphan state — no transition reaches it
        { who: "E" }, // absent still defaults to initial
      ],
      allowExplicitWorkflowState: true,
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.created, 3, JSON.stringify(r.value.results));
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ field: "who", op: "in", value: ["C", "D", "E"] }],
    });
    const byWho = Object.fromEntries(q.value.entries.map((e) => [e.data.who, e.data.status]));
    assert.deepEqual(byWho, { C: "closed", D: "kit", E: "new" });
  });

  it("#12: the flag does NOT bypass enum validation — a bogus state is still rejected", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "leads",
      data: { who: "F", status: "salesforce_legacy_9" },
      allowExplicitWorkflowState: true,
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /status/i);
  });

  it("#6: export pages walk to a complete, exact export (no skip, no dup)", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "contacts",
      fields: [{ name: "n", label: "N", type: "number", required: true }],
    });
    assert.ok(def.ok, def.errorText);
    // 130 rows across two bulk calls — the first 100 share one insert statement
    // (identical createdAt), so the cursor's (createdAt, id) tie-break is
    // exercised hard at every page boundary.
    for (const batch of [0, 100]) {
      const size = batch === 0 ? 100 : 30;
      const b = await mcp(p.mcpToken, "bulk_create_entries", {
        collection: "contacts",
        entries: Array.from({ length: size }, (_, i) => ({ n: batch + i })),
      });
      assert.ok(b.ok && b.value.created === size, b.errorText ?? JSON.stringify(b.value));
    }

    const seen = new Set();
    let cursor;
    let pages = 0;
    for (;;) {
      const page = await mcp(p.mcpToken, "export_entries", {
        collection: "contacts",
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(page.ok, page.errorText);
      for (const row of page.value.rows) {
        assert.ok(!seen.has(row.id), `row ${row.id} exported twice`);
        seen.add(row.id);
      }
      pages += 1;
      assert.equal(page.value.hasMore, Boolean(page.value.nextCursor));
      if (!page.value.nextCursor) break;
      assert.ok(pages < 10, "runaway paging");
      cursor = page.value.nextCursor;
    }
    assert.equal(pages, 3, "130 rows at limit 50 = 3 pages");
    assert.equal(seen.size, 130, "every row exported exactly once");
  });

  it("#6: csv pages each carry the header (standalone), so stitching drops later headers", async () => {
    const p1 = await mcp(p.mcpToken, "export_entries", { collection: "contacts", format: "csv", limit: 100 });
    assert.ok(p1.ok, p1.errorText);
    const header = p1.value.csv.split("\r\n")[0];
    assert.match(header, /^id,n,createdAt,updatedAt$/);
    assert.ok(p1.value.nextCursor, "100 of 130 → more pages");
    const p2 = await mcp(p.mcpToken, "export_entries", {
      collection: "contacts",
      format: "csv",
      limit: 100,
      cursor: p1.value.nextCursor,
    });
    assert.ok(p2.ok, p2.errorText);
    assert.equal(p2.value.csv.split("\r\n")[0], header, "each page is standalone csv");
    assert.equal(p2.value.rowCount, 30);
    assert.equal(p2.value.nextCursor, null);
  });

  it("#6: an invalid cursor is a clear validation error naming export_entries", async () => {
    const r = await mcp(p.mcpToken, "export_entries", { collection: "contacts", cursor: "not-a-cursor" });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /export_entries/);
  });
});
