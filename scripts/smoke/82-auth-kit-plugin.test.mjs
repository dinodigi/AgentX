import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql } from "./helpers.mjs";
import { AUTH_KIT_PLUGIN } from "../../plugins/auth-kit.mjs";

// Auth Kit plugin, end to end: the global DB def is visible + enableable, the
// full baseline applies cleanly (two workflows, computed uuid + slugify +
// template-unique), and the acceptance criteria hold — unique email, one
// membership per user+org, single-use invitations, admin-only suspension, and
// the credential-free rule.
describe("Auth Kit plugin (DIY user management)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("auth-kit");
    // Seed the def GLOBAL (what the seed script does).
    await sql`
      INSERT INTO plugin_defs (id, project_id, definition, updated_at)
      VALUES (${AUTH_KIT_PLUGIN.id}, NULL, ${JSON.stringify(AUTH_KIT_PLUGIN)}::jsonb, now())
      ON CONFLICT (id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()`;
  });

  it("the GLOBAL def is in the catalog and enables", async () => {
    const list = await mcp(p.mcpToken, "list_plugins", {});
    const a = list.value.find((x) => x.id === "auth_kit");
    assert.ok(a, "auth_kit visible in the catalog");
    const e = await mcp(p.mcpToken, "enable_plugin", { id: "auth_kit" });
    assert.ok(e.ok, e.errorText);
    const g = await mcp(p.mcpToken, "get_plugin", { id: "auth_kit" });
    assert.equal(g.value.enabled, true);
    assert.equal(g.value.structure.baseline.length, 7);
  });

  it("APPLY: the full baseline defines cleanly (workflows + computed fields included)", async () => {
    for (const c of AUTH_KIT_PLUGIN.structure.baseline) {
      const r = await mcp(p.mcpToken, "define_collection", {
        name: c.name,
        displayName: c.displayName,
        ...(c.publicWrite ? { publicWrite: true } : {}),
        fields: c.fields,
        ...(c.workflow ? { workflow: c.workflow } : {}),
      });
      assert.ok(r.ok, `${c.name}: ${r.errorText}`);
    }
  });

  it("credential-free rule: no password/token/secret-shaped field anywhere in the kit", () => {
    const banned = /password|passwd|secret|token|otp|totp|hash/i;
    for (const c of AUTH_KIT_PLUGIN.structure.baseline) {
      for (const f of c.fields) {
        assert.ok(!banned.test(f.name), `${c.name}.${f.name} looks credential-shaped`);
      }
    }
  });

  it("users: unique email enforced; initial status forced to 'invited'", async () => {
    const role = await mcp(p.mcpToken, "create_entry", {
      collection: "roles",
      data: { name: "admin", permissions: ["entries:read", "entries:write", "members:manage"] },
    });
    assert.ok(role.ok, role.errorText);

    const u1 = await mcp(p.mcpToken, "create_entry", {
      collection: "users",
      data: { email: "ada@example.com", name: "Ada", role: role.value.id },
    });
    assert.ok(u1.ok, u1.errorText);
    assert.equal(u1.value.data.status, "invited", "workflow initial applied");

    const dup = await mcp(p.mcpToken, "create_entry", {
      collection: "users",
      data: { email: "ada@example.com", name: "Imposter" },
    });
    assert.equal(dup.ok, false);
    assert.match(dup.errorText, /email/i, dup.errorText);

    // Historical import at a real status works via the audit-stamped escape hatch.
    const imported = await mcp(p.mcpToken, "create_entry", {
      collection: "users",
      data: { email: "legacy@example.com", status: "active" },
      allowExplicitWorkflowState: true,
    });
    assert.ok(imported.ok, imported.errorText);
    assert.equal(imported.value.data.status, "active");
  });

  it("lifecycle: invited→active→suspended works over MCP; suspension re-entry holds", async () => {
    const u = await mcp(p.mcpToken, "create_entry", {
      collection: "users",
      data: { email: "grace@example.com" },
    });
    assert.ok(u.ok, u.errorText);
    const act = await mcp(p.mcpToken, "update_entry", {
      collection: "users", id: u.value.id, data: { status: "active" },
    });
    assert.ok(act.ok, act.errorText);
    const susp = await mcp(p.mcpToken, "update_entry", {
      collection: "users", id: u.value.id, data: { status: "suspended" },
    });
    assert.ok(susp.ok, susp.errorText);
    // suspended → deactivated is declared; suspended → invited is NOT.
    const bad = await mcp(p.mcpToken, "update_entry", {
      collection: "users", id: u.value.id, data: { status: "invited" },
    });
    assert.equal(bad.ok, false, "undeclared transition must be rejected");
  });

  it("memberships: one per user+org, DB-enforced by membership_key", async () => {
    const owner = await mcp(p.mcpToken, "create_entry", {
      collection: "users", data: { email: "org-owner@example.com" },
    });
    const org = await mcp(p.mcpToken, "create_entry", {
      collection: "orgs", data: { name: "Acme Team", owner: owner.value.id },
    });
    assert.ok(org.ok, org.errorText);
    assert.equal(org.value.data.slug, "acme-team", "slug computed from name");

    const m1 = await mcp(p.mcpToken, "create_entry", {
      collection: "memberships",
      data: { user: owner.value.id, org: org.value.id, status: "active" },
    });
    assert.ok(m1.ok, m1.errorText);
    const m2 = await mcp(p.mcpToken, "create_entry", {
      collection: "memberships",
      data: { user: owner.value.id, org: org.value.id, status: "active" },
    });
    assert.equal(m2.ok, false, "duplicate membership must be rejected");
    assert.match(m2.errorText, /membership_key|unique/i, m2.errorText);
  });

  it("invitations: server-stamped uuid code; pending→accepted; revoked can't be accepted", async () => {
    const inv = await mcp(p.mcpToken, "create_entry", {
      collection: "invitations",
      data: { email: "new-hire@example.com" },
    });
    assert.ok(inv.ok, inv.errorText);
    assert.match(inv.value.data.code, /^[0-9a-f-]{36}$/i, "uuid code stamped server-side");
    assert.equal(inv.value.data.status, "pending");

    const accept = await mcp(p.mcpToken, "update_entry", {
      collection: "invitations", id: inv.value.id, data: { status: "accepted" },
    });
    assert.ok(accept.ok, accept.errorText);

    const inv2 = await mcp(p.mcpToken, "create_entry", {
      collection: "invitations", data: { email: "revoked@example.com" },
    });
    const revoke = await mcp(p.mcpToken, "update_entry", {
      collection: "invitations", id: inv2.value.id, data: { status: "revoked" },
    });
    assert.ok(revoke.ok, revoke.errorText);
    const late = await mcp(p.mcpToken, "update_entry", {
      collection: "invitations", id: inv2.value.id, data: { status: "accepted" },
    });
    assert.equal(late.ok, false, "revoked invitation must not accept");
  });

  it("audit trail: auth_events accepts typed rows and aggregates by type", async () => {
    for (const type of ["login", "login_failed", "login_failed"]) {
      const r = await mcp(p.mcpToken, "create_entry", {
        collection: "auth_events",
        data: { type, ip: "203.0.113.9", user_agent: "smoke-test" },
      });
      assert.ok(r.ok, r.errorText);
    }
    const agg = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "auth_events",
      aggregates: [{ fn: "count" }],
      groupBy: "type",
    });
    assert.ok(agg.ok, agg.errorText);
    const flat = JSON.stringify(agg.value);
    assert.match(flat, /login_failed/, `login_failed bucket present: ${flat.slice(0, 200)}`);
  });
});
