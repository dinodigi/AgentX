import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql } from "./helpers.mjs";

// Feedback wall + plugin-store management: send_feedback lands in
// platform_feedback; operator overrides (price display / fleet deactivate)
// flow through effectiveCatalog into list_plugins. Overrides target a
// PROJECT-SCOPED def so the shared control DB's real catalog is untouched;
// settings-cache convergence (<=60s TTL) is polled like test 69.
describe("feedback wall + plugin store management", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("feedback-store");
  });

  after(async () => {
    // Merge-remove ONLY our key — never clobber real overrides.
    await sql`UPDATE platform_settings SET value = value - 'wall_test_plugin' WHERE key = 'pluginOverrides'`;
  });

  it("send_feedback lands on the wall with the project attributed", async () => {
    const r = await mcp(p.mcpToken, "send_feedback", {
      category: "limitation",
      summary: "TEST: no way to express frobnication",
      detail: "tried X and Y; tool Z rejected it",
      toolName: "define_collection",
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.received, true);
    const rows = await sql`SELECT category, summary, tool_name, status FROM platform_feedback WHERE project_id = ${p.id}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, "limitation");
    assert.match(rows[0].summary, /frobnication/);
    assert.equal(rows[0].tool_name, "define_collection");
    assert.equal(rows[0].status, "new");
  });

  it("send_feedback rejects a bad category", async () => {
    const r = await mcp(p.mcpToken, "send_feedback", { category: "rant", summary: "x" });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /limitation\|bug\|friction\|idea/);
  });

  // The guard (operator decision): bug claims need receipts; ingest stamps
  // deterministic verification so hallucinated claims are visible on sight.
  it("guard: a bug report WITHOUT evidence is refused with the receipts hint", async () => {
    const r = await mcp(p.mcpToken, "send_feedback", {
      category: "bug",
      summary: "TEST: something is broken, trust me",
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /receipts|evidence/i, r.errorText);
    assert.match(r.errorText, /friction/i, "must offer the can't-reproduce path");
  });

  it("guard: a bug WITH receipts lands, verification confirms real code + tool", async () => {
    const r = await mcp(p.mcpToken, "send_feedback", {
      category: "bug",
      summary: "TEST: guarded bug report",
      toolName: "query_entries",
      evidence: {
        request: 'query_entries {collection:"posts", where:[{field:"x", op:"eq", value:1}]}',
        response: 'Error [E_VALIDATION]: unknown field "x"',
        reproduction: "define posts without x, query on x",
      },
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.warning, undefined, "real codes must not warn");
    const [row] = await sql`SELECT evidence, verification FROM platform_feedback
      WHERE project_id = ${p.id} AND summary LIKE 'TEST: guarded bug report'`;
    assert.match(row.evidence.request, /query_entries/);
    assert.deepEqual(row.verification.claimedCodes, ["E_VALIDATION"]);
    assert.deepEqual(row.verification.unknownCodes, []);
    assert.equal(row.verification.toolKnown, true);
    assert.ok(row.verification.platform, "platform stamp present");
  });

  it("guard: invented error codes and unknown tools get flagged, reporter warned", async () => {
    const r = await mcp(p.mcpToken, "send_feedback", {
      category: "bug",
      summary: "TEST: fails with E_FROBNICATION_DENIED",
      toolName: "quantum_entangle_entries",
      evidence: { request: "quantum_entangle_entries {}", response: "Error [E_FROBNICATION_DENIED]: no" },
    });
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.warning ?? "", /E_FROBNICATION_DENIED/, "reporter told the code doesn't exist");
    const [row] = await sql`SELECT verification FROM platform_feedback
      WHERE project_id = ${p.id} AND summary LIKE 'TEST: fails with E_FROBNICATION%'`;
    assert.deepEqual(row.verification.unknownCodes, ["E_FROBNICATION_DENIED"]);
    assert.equal(row.verification.toolKnown, false);
  });

  it("guard: non-bug categories still file without evidence (friction path stays open)", async () => {
    const r = await mcp(p.mcpToken, "send_feedback", {
      category: "friction",
      summary: "TEST: this felt awkward but I can't reproduce it",
    });
    assert.ok(r.ok, r.errorText);
  });

  it("bulk-resolve contract: OPEN → done, resolved rows untouched", async () => {
    // bulkResolveFeedbackAction is operator-gated (server auth), so exercise
    // the exact DB contract it runs, scoped to this project's rows.
    for (const s of [1, 2, 3]) await mcp(p.mcpToken, "send_feedback", { category: "idea", summary: `TEST bulk ${s}` });
    await mcp(p.mcpToken, "send_feedback", { category: "bug", summary: "TEST already-done" });
    await sql`UPDATE platform_feedback SET status = 'done' WHERE project_id = ${p.id} AND category = 'bug'`;

    const before = await sql`SELECT count(*)::int n FROM platform_feedback
      WHERE project_id = ${p.id} AND status IN ('new','reviewed','planned')`;
    assert.ok(before[0].n >= 3);
    // The action's statement (open → done):
    await sql`UPDATE platform_feedback SET status = 'done'
      WHERE project_id = ${p.id} AND status IN ('new','reviewed','planned')`;
    const openAfter = await sql`SELECT count(*)::int n FROM platform_feedback
      WHERE project_id = ${p.id} AND status IN ('new','reviewed','planned')`;
    const doneAfter = await sql`SELECT count(*)::int n FROM platform_feedback WHERE project_id = ${p.id} AND status = 'done'`;
    assert.equal(openAfter[0].n, 0, "no open items remain");
    assert.ok(doneAfter[0].n >= 4, "the already-done row plus the newly resolved are all done");
  });

  it("operator overrides: price attaches, deactivate hides — via list_plugins", async () => {
    const def = { id: "wall_test_plugin", version: "0.1.0", name: "Wall Test", description: "override target" };
    const d = await mcp(p.mcpToken, "define_plugin", { definition: def });
    assert.ok(d.ok, d.errorText);

    // Price override (merge into the settings key, never clobber).
    await sql`INSERT INTO platform_settings (key, value)
      VALUES ('pluginOverrides', '{"wall_test_plugin": {"priceCents": 1900}}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now()`;
    let priced;
    const deadline = Date.now() + 90_000;
    for (;;) {
      const list = await mcp(p.mcpToken, "list_plugins", {});
      priced = list.value.find((x) => x.id === "wall_test_plugin");
      if (priced?.price === "$19.00/mo") break;
      if (Date.now() > deadline) assert.fail(`price never converged: ${JSON.stringify(priced)}`);
      await new Promise((r2) => setTimeout(r2, 5000));
    }

    // Deactivate: must vanish from the catalog.
    await sql`UPDATE platform_settings
      SET value = value || '{"wall_test_plugin": {"active": false}}'::jsonb, updated_at = now()
      WHERE key = 'pluginOverrides'`;
    for (;;) {
      const list = await mcp(p.mcpToken, "list_plugins", {});
      if (!list.value.some((x) => x.id === "wall_test_plugin")) break;
      if (Date.now() > deadline) assert.fail("deactivated plugin still listed");
      await new Promise((r2) => setTimeout(r2, 5000));
    }
  });
});
