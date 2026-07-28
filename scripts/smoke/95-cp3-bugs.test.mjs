import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery, sql } from "./helpers.mjs";

// Burn-down CP3 — the two open bugs. Both were reproduced first (CLAUDE.md),
// and in both cases the reporter was right.

describe("E1 — a stale probe verdict must not read as a live fault", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("cp3-e1");
  });
  after(() => p.destroy());

  it("briefing health carries checkedAt, so a verdict can be dated", async () => {
    const info = await mcp(p.mcpToken, "get_project_info", {});
    const health = info.value.briefing?.health;
    assert.ok(health, "the briefing must expose health");
    assert.ok(Array.isArray(health.connectors));
    for (const c of health.connectors) {
      assert.ok("checkedAt" in c, `connector ${c.type} must carry checkedAt — status alone is undated`);
    }
  });

  it("THE BUG: an error status is reported as a FAILED CHECK, not a live fault", async () => {
    // Reproduce the reported state directly: the row says error while the
    // connector is fine. That is exactly what the reporter saw — r2 read error
    // while upload_asset succeeded and the public URL served 200.
    const [conn] = await sql`
      SELECT type FROM project_connectors WHERE project_id = ${p.id} LIMIT 1`;
    if (!conn) return; // ephemeral projects may carry no connector rows

    await sql`
      UPDATE project_connectors SET status = 'error', updated_at = now() - interval '3 hours'
      WHERE project_id = ${p.id} AND type = ${conn.type}`;

    const info = await mcp(p.mcpToken, "get_project_info", {});
    const line = (info.value.briefing?.attention ?? []).find((a) => a.includes(conn.type));
    assert.ok(line, "an error status must still raise attention");
    assert.match(line, /FAILED ITS LAST CHECK/, "says what we know: a probe failed");
    assert.match(line, /3h ago/, "and WHEN, so staleness is visible");
    assert.match(line, /may be working now/i, "and does not assert a fault we have not observed");

    const health = info.value.briefing.health.connectors.find((c) => c.type === conn.type);
    assert.ok(health.checkedAt, "the timestamp rides the structured field too");
  });
});

describe("E2 — a claim-write collection generates update()/remove()", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("cp3-e2");
    // Staff-write: a claim rule, no "owner". gateMutate allows PATCH/DELETE on
    // ANY row for a matching claim — the generator used to emit neither.
    await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "subject", label: "S", type: "text", required: true, publicRead: true },
        { name: "state", label: "St", type: "text", publicRead: true },
      ],
      access: { write: { claim: "role", equals: "staff" }, read: "public" },
    });
    // A LIST containing owner + a claim — the second shape the old check missed.
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
      ],
      access: { write: ["owner", { claim: "role", equals: "staff" }], ownerField: "owner", read: "public" },
    });
  });
  after(() => p.destroy());

  it("THE BUG: a lone claim rule now emits update() and remove()", async () => {
    const r = await mcp(p.mcpToken, "get_client_code", {});
    assert.ok(r.ok, r.errorText);
    const block = r.value.code.slice(r.value.code.indexOf("tickets: {"));
    assert.match(block.slice(0, 1200), /async update\(/, "PATCH is permitted by gateMutate — the client must offer it");
    assert.match(block.slice(0, 1200), /async remove\(/);
  });

  it("a LIST of [owner, claim] also emits them", async () => {
    const r = await mcp(p.mcpToken, "get_client_code", {});
    const block = r.value.code.slice(r.value.code.indexOf("notes: {"));
    assert.match(block.slice(0, 1200), /async update\(/);
    assert.match(block.slice(0, 1200), /async remove\(/);
  });

  it("and write:none still emits NEITHER — the fix must not open a hole", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "readonly_items",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
    const r = await mcp(p.mcpToken, "get_client_code", {});
    const idx = r.value.code.indexOf("readonly_items: {");
    const block = r.value.code.slice(idx, idx + 900);
    assert.doesNotMatch(block, /async update\(/, "no write rule means no mutators");
    assert.doesNotMatch(block, /async remove\(/);
  });

  it("the generated client matches REALITY: PATCH without the claim is refused", async () => {
    // The docs were right and the generator was wrong — but confirm the
    // endpoint truly exists, so we have not just taught the client to lie in
    // the opposite direction.
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "tickets",
      data: { subject: "printer on fire", state: "open" },
    });
    assert.ok(c.ok, c.errorText);
    const res = await delivery(p.deliveryToken, `/tickets/${c.value.id}`, {
      method: "PATCH",
      body: { state: "closed" },
    });
    // No user token → the claim cannot match → refused, but by the GATE
    // (401/403/404), never by the route being absent (405).
    assert.notEqual(res.status, 405, "the PATCH route must exist — that is the whole point");
    assert.ok([401, 403, 404].includes(res.status), `expected a gate refusal, got ${res.status}`);
  });
});
