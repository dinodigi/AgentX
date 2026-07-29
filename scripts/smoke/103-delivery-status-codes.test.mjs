import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer, createEphemeralProject, connectClerk, startMockIssuer, mcp, delivery,
} from "./helpers.mjs";

// Burn-down CP8-extra — which delivery failure is which.
//
// The reporter asked us to either return 401 for an unauthorized read, or
// document why it is a 404. Reproducing it split the question in two: an
// access-ruled collection WITH publicRead fields already returns a proper 401
// and sign-in hint. The 404 only appears when NO field is publicRead — and it
// is returned to an AUTHENTICATED caller too, so the status is right and 401
// would be a lie. What was missing is that nothing said so.

describe("delivery status codes — each says which question it answered", () => {
  let p, issuer;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("status-codes");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    await mcp(p.mcpToken, "define_collection", {
      name: "gated_pub",
      fields: [{ name: "t", label: "T", type: "text", required: true, publicRead: true }],
      access: { read: "authenticated" },
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "gated_nopub",
      fields: [{ name: "t", label: "T", type: "text", required: true }],
      access: { read: "authenticated" },
    });
  });
  after(async () => {
    await issuer?.close?.();
    await p.destroy();
  });

  it("access-ruled WITH public fields → 401 and a sign-in hint", async () => {
    const r = await delivery(p.deliveryToken, "/gated_pub");
    assert.equal(r.status, 401);
    assert.match(r.json.error, /X-User-Token/, "the fix must be in the message");
  });

  it("no public fields → 404, and it says signing in will NOT help", async () => {
    const r = await delivery(p.deliveryToken, "/gated_nopub");
    assert.equal(r.status, 404);
    assert.match(r.json.error, /not an auth failure/i);
    assert.match(r.json.error, /will NOT change it/);
  });

  it("THE PROOF that 404 is the honest code: an AUTHENTICATED caller gets it too", async () => {
    // If signing in fixed it, 401 would be the right status. It does not — so
    // 401 would send the caller to a door that does not open.
    const tok = await issuer.tokenFor("alice", { claims: {} });
    const r = await delivery(p.deliveryToken, "/gated_nopub", { userToken: tok });
    assert.equal(r.status, 404, "the 404 is identity-independent");
  });

  it("get_project_info explains the codes, so nobody reverse-engineers them", async () => {
    const info = await mcp(p.mcpToken, "get_project_info", {});
    const codes = info.value.deliveryApi?.statusCodes;
    assert.ok(codes, "the delivery orientation must carry a status-code guide");
    assert.match(codes, /IDENTITY-INDEPENDENT/);
    assert.match(codes, /X-User-Token/);
  });
});
