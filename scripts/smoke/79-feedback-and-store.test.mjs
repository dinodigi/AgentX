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
