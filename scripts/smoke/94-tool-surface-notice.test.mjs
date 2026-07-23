import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql, waitFor } from "./helpers.mjs";

// Friction sprint B1: a deploy that changes the MCP tool surface authors a
// platform notice, so a session that outlived the deploy learns about it from
// get_project_info instead of trusting its client's cached tools/list forever.
// Field proof: the Codex/Replit session filed "delivery token creation is not
// reachable over MCP" for tools that had been live for hours.
//
// The detector runs once per instance and CASes platform_settings.toolSurface.
// We simulate "the previous deploy had fewer tools" by rewriting the stored
// snapshot to an older shape, then re-arming the per-instance check via a tool
// call... which we cannot do (the flag is process-local and already spent).
// So this test drives the DETECTION path the way a NEW instance would see it:
// it validates the stored snapshot exists and matches the live surface, then
// exercises the NOTICE DELIVERY path end-to-end by inserting a notice the way
// the detector does and asserting the briefing carries it exactly once.
describe("tool-surface change notice (friction B1)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("surface-notice");
  });
  after(() => p.destroy());

  it("a tool call seeds the toolSurface snapshot matching the live surface", async () => {
    // Any tool call arms the once-per-instance detector (deferred write).
    await mcp(p.mcpToken, "list_collections", {});
    let row;
    await waitFor(async () => {
      const rows = await sql`SELECT value FROM platform_settings WHERE key = 'toolSurface'`;
      row = rows[0];
      return Boolean(row);
    });
    assert.ok(Array.isArray(row.value.names), "snapshot stores the tool name list");
    assert.ok(row.value.names.includes("mint_delivery_token"), "snapshot reflects the live surface");
    const prev = await sql`SELECT value FROM platform_settings WHERE key = 'toolSurfacePrev'`;
    assert.ok(prev[0], "diff baseline seeded on first boot");
  });

  it("a surface-change notice reaches the briefing once, then stops", async () => {
    // Author the notice exactly as the detector's win-branch does.
    await sql`INSERT INTO platform_notices (message, severity) VALUES
      ('platform deploy changed the MCP tool surface — new tools: imaginary_tool. If your session started before this notice, your client''s cached tool list is stale: re-run tools/list.', 'info')`;

    const info = await mcp(p.mcpToken, "get_project_info", {});
    const hit = info.value.briefing.notices.find((n) => /imaginary_tool/.test(n.message));
    assert.ok(hit, `briefing carries the surface notice: ${JSON.stringify(info.value.briefing.notices)}`);
    assert.match(hit.message, /re-run tools\/list/, "the notice tells the agent the remedy");

    // Shown once: the next briefing must not repeat it.
    const again = await mcp(p.mcpToken, "get_project_info", {});
    assert.equal(
      again.value.briefing.notices.some((n) => /imaginary_tool/.test(n.message)),
      false,
      "briefingSeenAt advanced — the notice is not repeated",
    );
  });
});
