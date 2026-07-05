import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  connectClerk,
  startMockIssuer,
  mcp,
  delivery,
} from "./helpers.mjs";

describe("identity: rules, stamping, owner endpoints", () => {
  let p, issuer, alice, bob, entryId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("identity");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    alice = await issuer.tokenFor("user_alice");
    bob = await issuer.tokenFor("user_bob");

    const def = await mcp(p.mcpToken, "define_collection", {
      name: "bookings",
      fields: [
        { name: "note", label: "Note", type: "text", publicRead: true },
        { name: "owner", label: "Owner", type: "text" },
      ],
      access: { read: "owner", write: "owner", ownerField: "owner" },
    });
    assert.ok(def.ok, def.errorText);
  });
  after(async () => {
    await issuer.close();
    await p.destroy();
  });

  it("owner rules without ownerField are rejected with a hint", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      fields: [{ name: "x", label: "X", type: "text" }],
      access: { read: "owner" },
    });
    assert.ok(!r.ok && /ownerField/.test(r.errorText));
  });

  it("anonymous and garbage tokens get 401", async () => {
    const anon = await delivery(p.deliveryToken, "/bookings");
    assert.equal(anon.status, 401);
    const garbage = await delivery(p.deliveryToken, "/bookings", { userToken: "not.a.jwt" });
    assert.equal(garbage.status, 401);
  });

  it("authenticated create stamps owner over any forged value", async () => {
    const r = await delivery(p.deliveryToken, "/bookings", {
      method: "POST",
      body: { note: "alice's", owner: "user_bob" },
      userToken: alice,
    });
    assert.equal(r.status, 201);
    entryId = r.json.id;
    const raw = await mcp(p.mcpToken, "get_entry", { collection: "bookings", id: entryId });
    assert.equal(raw.value.data.owner, "user_alice");
  });

  it("owner-scoped list: alice sees 1, bob sees 0", async () => {
    const a = await delivery(p.deliveryToken, "/bookings", { userToken: alice });
    assert.equal(a.json.data.length, 1);
    const b = await delivery(p.deliveryToken, "/bookings", { userToken: bob });
    assert.equal(b.json.data.length, 0);
  });

  it("cross-user single GET/PATCH/DELETE are 404", async () => {
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const r = await delivery(p.deliveryToken, `/bookings/${entryId}`, {
        method,
        body: method === "PATCH" ? { note: "hax" } : undefined,
        userToken: bob,
      });
      assert.equal(r.status, 404, `${method} should be 404 for non-owner`);
    }
  });

  // Verification-option tests get their OWN ephemeral projects: connectClerk
  // writes config via direct SQL, which bypasses tag revalidation — a fresh
  // project guarantees a cold connector cache instead of stale reconfigs.
  it("multi-issuer: tokens from any accepted issuer verify; strangers get 401", async () => {
    const p2 = await createEphemeralProject("identity-issuers");
    const staging = await startMockIssuer();
    try {
      await connectClerk(p2.id, issuer.issuer, { additionalIssuers: staging.issuer });
      await mcp(p2.mcpToken, "define_collection", {
        name: "notes",
        fields: [{ name: "body", label: "Body", type: "text", publicRead: true }],
        access: { read: "authenticated" },
      });

      const fromPrimary = await delivery(p2.deliveryToken, "/notes", {
        userToken: await issuer.tokenFor("user_a"),
      });
      assert.equal(fromPrimary.status, 200, JSON.stringify(fromPrimary.json));

      const fromStaging = await delivery(p2.deliveryToken, "/notes", {
        userToken: await staging.tokenFor("user_carol"),
      });
      assert.equal(fromStaging.status, 200, JSON.stringify(fromStaging.json));

      // Same KEY as the primary issuer but an unlisted iss claim — rejected by
      // the accepted-issuer list before any JWKS is even consulted.
      const stranger = await delivery(p2.deliveryToken, "/notes", {
        userToken: await issuer.tokenFor("user_x", { issuer: "https://evil.example" }),
      });
      assert.equal(stranger.status, 401);
      assert.match(stranger.json.error, /issuer not accepted/);
    } finally {
      await staging.close();
      await p2.destroy();
    }
  });

  it("audience: when configured, tokens minted for other apps are rejected", async () => {
    const p2 = await createEphemeralProject("identity-aud");
    try {
      await connectClerk(p2.id, issuer.issuer, { audience: "currents-site" });
      await mcp(p2.mcpToken, "define_collection", {
        name: "notes",
        fields: [{ name: "body", label: "Body", type: "text", publicRead: true }],
        access: { read: "authenticated" },
      });

      const wrongAud = await delivery(p2.deliveryToken, "/notes", {
        userToken: await issuer.tokenFor("user_a"),
      });
      assert.equal(wrongAud.status, 401, "token without the aud claim must fail");

      const rightAud = await delivery(p2.deliveryToken, "/notes", {
        userToken: await issuer.tokenFor("user_a", { aud: "currents-site" }),
      });
      assert.equal(rightAud.status, 200, JSON.stringify(rightAud.json));
    } finally {
      await p2.destroy();
    }
  });

  it("owner PATCH succeeds and ownership is immutable; owner DELETE 204", async () => {
    const patch = await delivery(p.deliveryToken, `/bookings/${entryId}`, {
      method: "PATCH",
      body: { note: "updated", owner: "user_bob" },
      userToken: alice,
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.data.note, "updated");
    const raw = await mcp(p.mcpToken, "get_entry", { collection: "bookings", id: entryId });
    assert.equal(raw.value.data.owner, "user_alice", "owner change ignored");

    const del = await delivery(p.deliveryToken, `/bookings/${entryId}`, {
      method: "DELETE",
      userToken: alice,
    });
    assert.equal(del.status, 204);
  });
});
