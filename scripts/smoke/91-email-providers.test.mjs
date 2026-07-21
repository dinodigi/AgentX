import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, connectEmailProvider, mcp, sql } from "./helpers.mjs";

// Connector provider registry: `email` is a CATEGORY served by resend OR
// elastic_email. The platform asks the category; adding a provider is an
// adapter + a map entry. One active provider per category, enforced at
// CONNECT time only — pre-existing connections are never re-judged.
describe("connector provider registry (email category)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("email-providers");
  });
  after(() => p.destroy());

  it("no provider: email-action gates refuse with a provider-neutral message", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [{ name: "subject", label: "S", type: "text", required: true }],
      events: { created: [{ type: "email", to: "ops@example.com", subject: "new" }] },
    });
    assert.equal(def.ok, false);
    // Provider-NEUTRAL framing: the requirement is the category; naming both
    // options is a helpful hint, but it must never read as "Resend required".
    assert.match(def.errorText, /an email provider/i, def.errorText);
    assert.match(def.errorText, /Elastic Email/i, "offers the alternative too: " + def.errorText);
  });

  it("ELASTIC EMAIL alone satisfies the category (no Resend anywhere)", async () => {
    await connectEmailProvider(p.id, "elastic_email", { key: "ee_smoke_key", fromEmail: "hi@smoke.test" });
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [{ name: "subject", label: "S", type: "text", required: true }],
      events: { created: [{ type: "email", to: "ops@example.com", subject: "new" }] },
    });
    assert.ok(def.ok, `elastic_email must satisfy the email gate: ${def.errorText}`);

    const sched = await mcp(p.mcpToken, "define_schedule", {
      name: "digest",
      recurrence: { frequency: "daily", at: "09:00" },
      action: { type: "email", to: "ops@example.com", subject: "daily" },
    });
    assert.ok(sched.ok, `schedule email gate too: ${sched.errorText}`);
  });

  it("list_connectors reports the CATEGORY alongside the provider type", async () => {
    const r = await mcp(p.mcpToken, "list_connectors", {});
    assert.ok(r.ok, r.errorText);
    const row = r.value.find((c) => c.type === "elastic_email");
    assert.ok(row, JSON.stringify(r.value));
    assert.equal(row.category, "email");
    assert.equal(row.config.fromEmail, "hi@smoke.test", "fromEmail is surfaced for the new provider too");
  });

  it("a send attempt routes to the ACTIVE provider (elastic), logged as a delivery", async () => {
    const created = await mcp(p.mcpToken, "create_entry", {
      collection: "tickets",
      data: { subject: "routed" },
    });
    assert.ok(created.ok, created.errorText);
    // The fake key can't succeed upstream; what matters is that the send was
    // ATTEMPTED through the registry and logged (not skipped as unconfigured).
    let row = null;
    for (let i = 0; i < 14 && !row; i++) {
      const rows = await sql`SELECT status, url, last_error FROM webhook_deliveries
        WHERE project_id = ${p.id} AND url LIKE 'email:%' ORDER BY created_at DESC LIMIT 1`;
      row = rows[0] ?? null;
      if (!row) await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(row, "an email delivery row should exist");
    assert.doesNotMatch(row.last_error ?? "", /not configured|no email provider/i,
      `provider was resolved, not skipped: ${row.last_error}`);
    assert.match(row.last_error ?? "", /Elastic Email/i,
      `the elastic adapter handled it: ${row.last_error}`);
  });

  it("GRANDFATHER: a pre-existing second provider row keeps working (registry order decides)", async () => {
    // Pre-rule state, seeded straight into the DB: both providers connected.
    await connectEmailProvider(p.id, "resend", { key: "re_smoke_key", fromEmail: "legacy@smoke.test" });
    const list = await mcp(p.mcpToken, "list_connectors", {});
    const types = list.value.filter((c) => c.category === "email").map((c) => c.type).sort();
    assert.deepEqual(types, ["elastic_email", "resend"], "both rows survive — nothing is auto-disabled");
    // The gate still passes, deterministically (resend wins by registry order).
    const still = await mcp(p.mcpToken, "define_schedule", {
      name: "digest2",
      recurrence: { frequency: "daily", at: "10:00" },
      action: { type: "email", to: "ops@example.com", subject: "still fine" },
    });
    assert.ok(still.ok, still.errorText);
  });
});
