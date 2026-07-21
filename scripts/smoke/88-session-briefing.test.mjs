import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql } from "./helpers.mjs";

// Plugin Bases Plan, Track C — the session briefing: get_project_info carries
// update OFFERS (acknowledged version vs catalog), platform notices shown
// once per project, and health. Adoption = re-reconcile + enable_plugin again
// to acknowledge; nothing auto-applies.
describe("session briefing (get_project_info)", () => {
  let p;
  const noticeMsg = `TEST notice ${Date.now()}`;
  let noticeId;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("briefing");
  });
  after(async () => {
    if (noticeId) await sql`DELETE FROM platform_notices WHERE id = ${noticeId}`;
    await p.destroy();
  });

  it("fresh enable stamps the catalog version — no update offer", async () => {
    const e = await mcp(p.mcpToken, "enable_plugin", { id: "auth_kit" });
    assert.ok(e.ok, e.errorText);
    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(info.ok, info.errorText);
    const b = info.value.briefing;
    assert.ok(b, "briefing present");
    assert.deepEqual(b.updates.filter((u) => u.plugin === "auth_kit"), [], JSON.stringify(b.updates));
    assert.ok(Array.isArray(b.attention));
    assert.ok(Number.isFinite(b.health.failedDeliveries24h));
  });

  it("stale acknowledged version surfaces an update offer; MAJOR bump lands in attention", async () => {
    await sql`UPDATE project_plugins SET version = '0.9.0' WHERE project_id = ${p.id} AND plugin_id = 'auth_kit'`;
    const info = await mcp(p.mcpToken, "get_project_info", {});
    const b = info.value.briefing;
    const offer = b.updates.find((u) => u.plugin === "auth_kit");
    assert.ok(offer, JSON.stringify(b.updates));
    assert.equal(offer.from, "0.9.0");
    assert.match(offer.to, /^\d+\.\d+\.\d+$/);
    assert.match(b.attention.join(" "), /auth_kit.*MAJOR/i, "0.x → 1.x is a major bump");
  });

  it("re-running enable_plugin acknowledges the version and clears the offer", async () => {
    const ack = await mcp(p.mcpToken, "enable_plugin", { id: "auth_kit" });
    assert.ok(ack.ok, ack.errorText);
    assert.match((ack.value.notes ?? []).join(" "), /acknowledged version/);
    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.deepEqual(
      info.value.briefing.updates.filter((u) => u.plugin === "auth_kit"),
      [],
      "offer gone after acknowledgment",
    );
  });

  it("null version (enabled before tracking) offers adopt-current with the note", async () => {
    await sql`UPDATE project_plugins SET version = NULL WHERE project_id = ${p.id} AND plugin_id = 'auth_kit'`;
    const info = await mcp(p.mcpToken, "get_project_info", {});
    const offer = info.value.briefing.updates.find((u) => u.plugin === "auth_kit");
    assert.ok(offer, "legacy enablement gets an offer");
    assert.equal(offer.from, null);
    assert.match(offer.note ?? "", /before version tracking/);
  });

  it("platform notices show once, then clear; attention severity escalates", async () => {
    const [row] = await sql`INSERT INTO platform_notices (message, severity)
      VALUES (${noticeMsg}, 'attention') RETURNING id`;
    noticeId = row.id;
    const first = await mcp(p.mcpToken, "get_project_info", {});
    const b1 = first.value.briefing;
    assert.ok(b1.notices.some((n) => n.message === noticeMsg), "notice visible on first read");
    assert.match(b1.attention.join(" "), new RegExp(noticeMsg.slice(0, 20)), "attention severity escalates");
    const second = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(
      !second.value.briefing.notices.some((n) => n.message === noticeMsg),
      "seen notices don't repeat",
    );
  });
});
