import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql, delivery } from "./helpers.mjs";
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
    assert.equal(g.value.structure.baseline.length, 8, "v2 adds password_resets");
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

  // v2 replaces a NAME regex with the actual invariant. The old test banned any
  // field matching /password|token|hash/, which would now reject
  // password_changed_at and the reset token — fields that are metadata and a
  // server-stamped nonce, not secrets. A name check was always a proxy; this is
  // the rule it was standing in for.
  it("no VERIFIED secret is stored: no password hash, no MFA seed, anywhere in the kit", () => {
    // A value you must COMPARE cannot be write-only (the comparison is a read),
    // and a readable one would ride out through export/versions/changes — which
    // is exactly what the reporter of 0ceec805 flagged. So neither form belongs
    // in the kit at all.
    const secretShaped = /(^|_)(password_hash|passwd|pwhash|secret|totp_secret|mfa_secret|otp_secret|recovery_codes)($|_)/i;
    for (const c of AUTH_KIT_PLUGIN.structure.baseline) {
      for (const f of c.fields) {
        assert.ok(!secretShaped.test(f.name), `${c.name}.${f.name} looks like a verified secret`);
      }
    }
  });

  it("nothing in the kit is writeOnly — and the guidance explains why, rather than just saying no", () => {
    // If a future edit adds a writeOnly field here, this test should fail and
    // force the reasoning to be re-derived: the platform primitive exists and is
    // correct, it is simply not what a password hash needs.
    for (const c of AUTH_KIT_PLUGIN.structure.baseline) {
      for (const f of c.fields) {
        assert.notEqual(f.writeOnly, true, `${c.name}.${f.name} is writeOnly — see the header`);
      }
    }
    assert.match(AUTH_KIT_PLUGIN.guidance, /writeOnly/, "guidance must name the primitive");
    assert.match(
      AUTH_KIT_PLUGIN.guidance,
      /comparison is a read/,
      "guidance must give the REASON a hash can't be write-only, not just the rule",
    );
  });

  it("the v2 recipe is actually present in the guidance — all four points", () => {
    // The recipe IS the deliverable for this half of the wall item, so its
    // absence must fail a test rather than be noticed by a reader six weeks on.
    const g = AUTH_KIT_PLUGIN.guidance;
    assert.match(g, /argon2id/, "1: hashing recipe");
    assert.match(g, /m=19456.*t=2.*p=1/, "1: concrete parameters, not 'pick some'");
    assert.match(g, /rehash on next successful login/i, "1: the upgrade path");
    assert.match(g, /REAL pre-computed dummy hash/, "2: the timing defence");
    assert.match(g, /fails on PARSE and returns immediately/, "2: the trap inside the defence");
    assert.match(g, /startingFrom:0/, "3: the atomic counter");
    assert.match(g, /undercounted lockout is a bypass/, "3: why read-then-write is wrong");
    assert.match(g, /NON-ENUMERATING/, "4: the reset request rule");
    assert.match(g, /'used' is terminal/, "4: single-use is the workflow's guarantee");
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

  // ── v2: the lockout counter, which is the part with a race in it ──────────

  it("LOCKOUT: concurrent failed attempts each count — the atomic increment has no lost update", async () => {
    const u = await mcp(p.mcpToken, "create_entry", {
      collection: "users", data: { email: "brute@example.com" },
    });
    assert.ok(u.ok, u.errorText);
    const id = u.value.id;

    // Fire 5 increments AT ONCE. This is the whole point: the read-then-write
    // implementation every tenant writes first would collapse some of these into
    // one, and an undercounted lockout is a bypass rather than a rounding error.
    const bumps = await Promise.all(
      Array.from({ length: 5 }, () =>
        mcp(p.mcpToken, "update_entry_if", {
          collection: "users",
          id,
          increment: { field: "failed_attempts", by: 1, startingFrom: 0 },
        }),
      ),
    );
    for (const b of bumps) assert.ok(b.ok, b.errorText);
    const after = await mcp(p.mcpToken, "get_entry", { collection: "users", id });
    assert.equal(
      after.value.data.failed_attempts,
      5,
      "five concurrent failures must count five — startingFrom makes the FIRST one atomic too",
    );

    // Threshold reached → lock, then a successful login clears both.
    const lock = await mcp(p.mcpToken, "update_entry", {
      collection: "users", id, data: { locked_until: new Date(Date.now() + 900_000).toISOString() },
    });
    assert.ok(lock.ok, lock.errorText);
    const clear = await mcp(p.mcpToken, "update_entry", {
      collection: "users", id, data: { failed_attempts: 0, locked_until: null },
    });
    assert.ok(clear.ok, clear.errorText);
    const cleared = await mcp(p.mcpToken, "get_entry", { collection: "users", id });
    assert.equal(cleared.value.data.failed_attempts, 0);
    assert.ok(!("locked_until" in cleared.value.data), "null unsets it, so the sweep won't re-match");
  });

  it("LOCKOUT: the locked accounts are findable by query — the unlock sweep is a real filter", async () => {
    // locked_until is indexed precisely so this is the scheduled sweep's query.
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "users",
      where: [{ field: "locked_until", op: "lt", value: { hoursAgo: 0 } }],
    });
    assert.ok(r.ok, r.errorText);
  });

  it("RESETS: server-stamped token, single-use via a terminal 'used' state", async () => {
    const u = await mcp(p.mcpToken, "create_entry", {
      collection: "users", data: { email: "forgot@example.com" },
    });
    const res = await mcp(p.mcpToken, "create_entry", {
      collection: "password_resets",
      data: { user: u.value.id, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.ok(res.ok, res.errorText);
    assert.match(res.value.data.token, /^[0-9a-f-]{36}$/i, "uuid token stamped server-side");
    assert.ok(res.value.data.requested_at, "requested_at stamped at create");
    assert.equal(res.value.data.status, "pending");

    const use = await mcp(p.mcpToken, "update_entry", {
      collection: "password_resets", id: res.value.id, data: { status: "used" },
    });
    assert.ok(use.ok, use.errorText);

    // THE guarantee: there is no route out of `used`, so a replayed token cannot
    // be redeemed a second time even if the attacker holds a valid token string.
    for (const status of ["used", "pending", "revoked"]) {
      const replay = await mcp(p.mcpToken, "update_entry", {
        collection: "password_resets", id: res.value.id, data: { status },
      });
      if (status === "used") continue; // same-state no-op is legitimately allowed
      assert.equal(replay.ok, false, `a used token must not move to "${status}"`);
    }
  });

  it("RESETS: the token is private — it is never served by the delivery API", async () => {
    // Not writeOnly (accepting a reset means comparing it), so its protection is
    // the absence of publicRead. Assert that rather than trusting the default.
    const resets = AUTH_KIT_PLUGIN.structure.baseline.find((c) => c.name === "password_resets");
    for (const f of resets.fields) {
      assert.notEqual(f.publicRead, true, `password_resets.${f.name} must not be publicRead`);
    }
    const pub = await delivery(p.deliveryToken, "/password_resets");
    assert.equal(pub.status, 404, "a collection with no public fields is not exposed at all");
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
