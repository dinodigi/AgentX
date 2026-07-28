import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer, createEphemeralProject, connectClerk, startMockIssuer, mcp, delivery,
} from "./helpers.mjs";

// Burn-down CP5 / field-signal A5 — publicWrite and access.write COMPOSE.
//
// They used to replace each other: any non-`none` write rule sent a tokenless
// POST to the auth gate and a 401, so "anonymous form in, staff triage desk" —
// the single most common shape on the platform — forced splitting one
// collection into two. Two reporters hit it independently, six days apart.

describe("A5 — anonymous intake alongside gated mutation", () => {
  let p, issuer;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("anon-intake");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    // THE SHAPE: anyone may submit; only staff may triage.
    await mcp(p.mcpToken, "define_collection", {
      name: "enquiries",
      publicWrite: true,
      fields: [
        { name: "message", label: "M", type: "text", required: true, publicRead: true },
        { name: "state", label: "S", type: "text", publicRead: true },
      ],
      access: { read: "public", write: { claim: "role", equals: "staff" } },
    });
  });
  after(async () => {
    await issuer?.close?.();
    await p.destroy();
  });

  it("THE BUG: a tokenless POST is accepted, not 401'd", async () => {
    const res = await delivery(p.deliveryToken, "/enquiries", {
      method: "POST",
      body: { message: "do you deliver on sundays?" },
    });
    assert.ok([200, 201].includes(res.status), `anonymous intake must work: ${res.status} ${JSON.stringify(res.json)}`);
    assert.ok(res.json.id);
  });

  it("...while PATCH still requires the claim — the gate did NOT widen", async () => {
    const created = await delivery(p.deliveryToken, "/enquiries", {
      method: "POST",
      body: { message: "gate check" },
    });
    const anon = await delivery(p.deliveryToken, `/enquiries/${created.json.id}`, {
      method: "PATCH",
      body: { state: "closed" },
    });
    assert.notEqual(anon.status, 200, "anonymous must never mutate an existing row");

    const visitor = await issuer.tokenFor("visitor", { claims: { role: "visitor" } });
    const wrong = await delivery(p.deliveryToken, `/enquiries/${created.json.id}`, {
      method: "PATCH", body: { state: "closed" }, userToken: visitor,
    });
    assert.notEqual(wrong.status, 200, "a signed-in non-staff user must not triage either");
  });

  it("...and staff CAN triage — the other half of the shape", async () => {
    const created = await delivery(p.deliveryToken, "/enquiries", {
      method: "POST", body: { message: "staff path" },
    });
    const staff = await issuer.tokenFor("sam", { claims: { role: "staff" } });
    const patched = await delivery(p.deliveryToken, `/enquiries/${created.json.id}`, {
      method: "PATCH", body: { state: "closed" }, userToken: staff,
    });
    assert.equal(patched.status, 200, `staff must triage: ${JSON.stringify(patched.json)}`);
  });

  it("a signed-in user who MISSES the claim may still submit, and is attributed", async () => {
    // Refusing them would be theatre: they can drop the token and post
    // anonymously, which is strictly more permissive. Allowing it attributed
    // beats making someone de-authenticate to succeed.
    const visitor = await issuer.tokenFor("visitor", { claims: { role: "visitor" } });
    const res = await delivery(p.deliveryToken, "/enquiries", {
      method: "POST", body: { message: "signed in but not staff" }, userToken: visitor,
    });
    assert.ok([200, 201].includes(res.status), `must not force the user to de-authenticate: ${res.status} ${JSON.stringify(res.json)}`);
  });

  it("an INVALID token still 401s — a broken credential is not 'no credential'", async () => {
    const res = await delivery(p.deliveryToken, "/enquiries", {
      method: "POST", body: { message: "bad token" }, userToken: "not.a.jwt",
    });
    assert.equal(res.status, 401, "silently downgrading a bad token would hide real auth bugs");
  });

  it("publicWrite:false + a claim rule still refuses anonymous — nothing widened", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "internal",
      fields: [{ name: "note", label: "N", type: "text", required: true, publicRead: true }],
      access: { read: "public", write: { claim: "role", equals: "staff" } },
    });
    const res = await delivery(p.deliveryToken, "/internal", {
      method: "POST", body: { note: "should not land" },
    });
    assert.notEqual(res.status, 200, "no publicWrite means no anonymous create");
  });

  it("the plain publicWrite case is untouched", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "plain_forms",
      publicWrite: true,
      fields: [{ name: "note", label: "N", type: "text", required: true }],
    });
    const res = await delivery(p.deliveryToken, "/plain_forms", {
      method: "POST", body: { note: "classic" },
    });
    assert.ok([200, 201].includes(res.status), `the original anonymous form must still work: ${res.status} ${JSON.stringify(res.json)}`);
  });

  it("publicWrite + an OWNER scope is refused at define time, not silently orphaned", async () => {
    // stampIdentity strips an ownerField it cannot verify, so such a row would
    // be invisible to owner-scoped reads and permanently unmutatable. The bar
    // used to fire only when write was exactly "none"; composition means it
    // must fire whenever publicWrite is on.
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "owned_intake",
      publicWrite: true,
      fields: [
        { name: "note", label: "N", type: "text", required: true },
        { name: "owner", label: "O", type: "text" },
      ],
      access: { read: "owner", write: "owner", ownerField: "owner" },
    });
    assert.equal(r.ok, false, "an unattributable row must be refused at define time");
    assert.match(r.errorText, /orphaned|anonymous writes/i);
  });
});
