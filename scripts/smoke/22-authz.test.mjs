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

describe("authz: claim-based rules (F1) + any-of presets (F2)", () => {
  let p, issuer;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("authz");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);

    // write requires role=editor; read is public
    const w = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
      access: { read: "public", write: { claim: "role", equals: "editor" } },
    });
    assert.ok(w.ok, w.errorText);

    // any-of: owner OR moderator role may write; owner needs ownerField
    const anyOf = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
      ],
      access: {
        read: "public",
        write: ["owner", { claim: "role", equals: "moderator" }],
        ownerField: "owner",
      },
    });
    assert.ok(anyOf.ok, anyOf.errorText);
  });
  after(async () => {
    await issuer.close();
    await p.destroy();
  });

  it("claim-write: role=editor may create (201)", async () => {
    const t = await issuer.tokenFor("u1", { claims: { role: "editor" } });
    const r = await delivery(p.deliveryToken, "/articles", {
      method: "POST",
      body: { title: "hi" },
      userToken: t,
    });
    assert.equal(r.status, 201);
  });

  it("claim-write: role=viewer is 403 naming the observed value", async () => {
    const t = await issuer.tokenFor("u2", { claims: { role: "viewer" } });
    const r = await delivery(p.deliveryToken, "/articles", {
      method: "POST",
      body: { title: "x" },
      userToken: t,
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "E_SCOPE");
    assert.match(r.json.error, /"role"="editor"/);
    assert.match(r.json.error, /has role="viewer"/);
  });

  it("claim-write: token WITHOUT the claim is 403 saying it's absent", async () => {
    const t = await issuer.tokenFor("u3", {});
    const r = await delivery(p.deliveryToken, "/articles", {
      method: "POST",
      body: { title: "x" },
      userToken: t,
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /no string "role" claim/);
  });

  it("claim-write: a non-string claim value (object) fails closed with the same 403 shape", async () => {
    const t = await issuer.tokenFor("u4", { claims: { role: { nested: "editor" } } });
    const r = await delivery(p.deliveryToken, "/articles", {
      method: "POST",
      body: { title: "x" },
      userToken: t,
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /no string "role" claim/);
  });

  it("claim-write allows mutating ANY row (staff write), owner is scoped to own rows", async () => {
    // A moderator creates + can PATCH someone else's post; an owner-only user can't.
    const mod = await issuer.tokenFor("mod1", { claims: { role: "moderator" } });
    const alice = await issuer.tokenFor("alice", {});
    const bob = await issuer.tokenFor("bob", {});

    // alice (owner path) creates a post; owner is stamped to alice
    const created = await delivery(p.deliveryToken, "/posts", { method: "POST", body: { body: "a" }, userToken: alice });
    assert.equal(created.status, 201);
    const id = created.json.id;

    // bob (owner path, not the owner) cannot PATCH it → 404
    const bobPatch = await delivery(p.deliveryToken, `/posts/${id}`, { method: "PATCH", body: { body: "hax" }, userToken: bob });
    assert.equal(bobPatch.status, 404);

    // moderator (claim-write staff) CAN PATCH any row
    const modPatch = await delivery(p.deliveryToken, `/posts/${id}`, { method: "PATCH", body: { body: "moderated" }, userToken: mod });
    assert.equal(modPatch.status, 200);
    assert.equal(modPatch.json.data.body, "moderated");
  });

  it("any-of read: authenticated OR moderator", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "text", label: "T", type: "text", required: true, publicRead: true }],
      access: { read: ["authenticated", { claim: "role", equals: "moderator" }], write: "none" },
    });
    // any authenticated user reads (authenticated preset passes)
    const anyUser = await issuer.tokenFor("who", {});
    const r = await delivery(p.deliveryToken, "/notes", { userToken: anyUser });
    assert.equal(r.status, 200);
    // anonymous is 401
    const anon = await delivery(p.deliveryToken, "/notes");
    assert.equal(anon.status, 401);
  });

  it("define-time: a claim rule needs no ownerField; a bad preset string is rejected", async () => {
    const noOwner = await mcp(p.mcpToken, "define_collection", {
      name: "ok_claim",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
      access: { write: { claim: "role", equals: "admin" } }, // no ownerField — fine
    });
    assert.ok(noOwner.ok, noOwner.errorText);

    const bad = await mcp(p.mcpToken, "define_collection", {
      name: "bad_preset",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
      access: { read: "everyone" },
    });
    assert.ok(!bad.ok, "invalid preset should be rejected");
  });
});

describe("authz: org/team row scoping (F3)", () => {
  let p, issuer, acme, globex;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("authz-org");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    acme = await issuer.tokenFor("u_acme", { claims: { org_id: "acme" } });
    globex = await issuer.tokenFor("u_globex", { claims: { org_id: "globex" } });

    const def = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "subject", label: "S", type: "text", required: true, publicRead: true },
        { name: "owner", label: "Owner", type: "text", publicRead: true },
        { name: "org", label: "Org", type: "text", publicRead: true },
      ],
      access: {
        read: "authenticated",
        write: "owner",
        ownerField: "owner",
        org: { claim: "org_id", field: "org" },
      },
    });
    assert.ok(def.ok, def.errorText);
  });
  after(async () => {
    await issuer.close();
    await p.destroy();
  });

  it("each org sees only its own rows; create stamps the org from the JWT (spoof ignored)", async () => {
    // acme creates with a SPOOFED org value → stored value is the JWT claim
    const c = await delivery(p.deliveryToken, "/tickets", {
      method: "POST",
      body: { subject: "acme issue", org: "globex" }, // spoof
      userToken: acme,
    });
    assert.equal(c.status, 201);
    const acmeRow = await mcp(p.mcpToken, "get_entry", { collection: "tickets", id: c.json.id });
    assert.equal(acmeRow.value.data.org, "acme", "org must be the JWT claim, not the spoofed body");

    await delivery(p.deliveryToken, "/tickets", { method: "POST", body: { subject: "globex issue" }, userToken: globex });

    const acmeList = await delivery(p.deliveryToken, "/tickets", { userToken: acme });
    assert.ok(acmeList.json.data.every((t) => t.subject === "acme issue"));
    const globexList = await delivery(p.deliveryToken, "/tickets", { userToken: globex });
    assert.ok(globexList.json.data.every((t) => t.subject === "globex issue"));

    // cross-org single GET is 404
    const acmeId = acmeList.json.data[0].id;
    const cross = await delivery(p.deliveryToken, `/tickets/${acmeId}`, { userToken: globex });
    assert.equal(cross.status, 404);
  });

  it("a token WITHOUT the org claim is 403 on every operation", async () => {
    const noOrg = await issuer.tokenFor("u_noorg", {});
    const list = await delivery(p.deliveryToken, "/tickets", { userToken: noOrg });
    assert.equal(list.status, 403);
    assert.match(list.json.error, /org_id/);
    const create = await delivery(p.deliveryToken, "/tickets", { method: "POST", body: { subject: "x" }, userToken: noOrg });
    assert.equal(create.status, 403);
  });

  it("an object-valued org claim fails closed (403)", async () => {
    const objOrg = await issuer.tokenFor("u_obj", { claims: { org_id: { o: "acme" } } });
    const list = await delivery(p.deliveryToken, "/tickets", { userToken: objOrg });
    assert.equal(list.status, 403);
  });

  it("PATCH cannot move a row to another org (org field stripped)", async () => {
    const list = await delivery(p.deliveryToken, "/tickets", { userToken: acme });
    const id = list.json.data[0].id;
    const patch = await delivery(p.deliveryToken, `/tickets/${id}`, {
      method: "PATCH",
      body: { subject: "edited", org: "globex" }, // try to move org
      userToken: acme,
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.data.subject, "edited");
    assert.equal(patch.json.data.org, "acme", "org must be unchanged (stripped from PATCH)");
  });

  it("define-time: org + read:public is rejected; org + anonymous write is rejected", async () => {
    const pubOrg = await mcp(p.mcpToken, "define_collection", {
      name: "bad_pub",
      fields: [{ name: "o", label: "O", type: "text", publicRead: true }],
      access: { read: "public", org: { claim: "org_id", field: "o" } },
    });
    assert.ok(!pubOrg.ok && /cannot be combined with read:"public"/.test(pubOrg.errorText), pubOrg.errorText);

    const anonOrg = await mcp(p.mcpToken, "define_collection", {
      name: "bad_anon",
      publicWrite: true,
      fields: [{ name: "o", label: "O", type: "text" }],
      // read authenticated (passes the public check) but write defaults to none + publicWrite
      access: { read: "authenticated", org: { claim: "org_id", field: "o" } },
    });
    assert.ok(!anonOrg.ok && /cannot accept anonymous writes/.test(anonOrg.errorText), anonOrg.errorText);
  });
});

describe("authz: field-level write rules (F4)", () => {
  let p, issuer;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("authz-f4");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    // public form: anonymous submissions, but `internal` is never delivery-writable
    await mcp(p.mcpToken, "define_collection", {
      name: "forms",
      publicWrite: true,
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "internal", label: "I", type: "text", publicRead: true, writableBy: "none" },
      ],
    });
    // authenticated collection: `status` writable only by role=moderator
    await mcp(p.mcpToken, "define_collection", {
      name: "tasks",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
        { name: "status", label: "S", type: "text", publicRead: true, writableBy: { claim: "role", equals: "moderator" } },
      ],
      access: { read: "authenticated", write: "owner", ownerField: "owner" },
    });
  });
  after(async () => {
    await issuer.close();
    await p.destroy();
  });

  it("anonymous POST with a writableBy:'none' field is 403 naming it; without it 201", async () => {
    const blocked = await delivery(p.deliveryToken, "/forms", { method: "POST", body: { title: "t", internal: "secret" } });
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error, /internal/);
    const ok = await delivery(p.deliveryToken, "/forms", { method: "POST", body: { title: "ok" } });
    assert.equal(ok.status, 201);
  });

  it("a moderator JWT may write the claim-gated field; a plain token cannot", async () => {
    const mod = await issuer.tokenFor("m", { claims: { role: "moderator" } });
    const modPost = await delivery(p.deliveryToken, "/tasks", { method: "POST", body: { title: "t2", status: "triaged" }, userToken: mod });
    assert.equal(modPost.status, 201);

    const plain = await issuer.tokenFor("u", {});
    const plainPost = await delivery(p.deliveryToken, "/tasks", { method: "POST", body: { title: "t3", status: "triaged" }, userToken: plain });
    assert.equal(plainPost.status, 403);
    assert.match(plainPost.json.error, /status/);
    // plain user CAN create without the gated field
    const okPost = await delivery(p.deliveryToken, "/tasks", { method: "POST", body: { title: "t4" }, userToken: plain });
    assert.equal(okPost.status, 201);
  });

  it("PATCH gating: a plain user can't set status; a moderator can", async () => {
    const plain = await issuer.tokenFor("owner1", {});
    const created = await delivery(p.deliveryToken, "/tasks", { method: "POST", body: { title: "mine" }, userToken: plain });
    const id = created.json.id;
    // owner (plain) PATCH of a gated field → 403
    const bad = await delivery(p.deliveryToken, `/tasks/${id}`, { method: "PATCH", body: { status: "done" }, userToken: plain });
    assert.equal(bad.status, 403);
    assert.match(bad.json.error, /status/);
    // owner can still PATCH non-gated fields
    const ok = await delivery(p.deliveryToken, `/tasks/${id}`, { method: "PATCH", body: { title: "renamed" }, userToken: plain });
    assert.equal(ok.status, 200);
  });

  it("MCP (trusted) can set gated fields directly", async () => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "tasks", data: { title: "mcp", status: "done" } });
    assert.ok(r.ok, r.errorText);
    const f = await mcp(p.mcpToken, "create_entry", { collection: "forms", data: { title: "mcp2", internal: "notes" } });
    assert.ok(f.ok, f.errorText);
  });
});

// Regressions for the Phase 12 adversarial review (all confirmed real):
//  A — anonymous publicWrite could forge ownerField (owner twin of the org bar)
//  B — relation {id,label} resolution leaked an org-scoped target's label cross-org
//  C — PATCH/DELETE were unthrottled while claim-write grants any-row mutation
describe("authz: Phase-12 review regressions", () => {
  let p, issuer, acme, globex;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("authz-regress");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    acme = await issuer.tokenFor("u_acme", { claims: { org_id: "acme" } });
    globex = await issuer.tokenFor("u_globex", { claims: { org_id: "globex" } });

    // org-scoped tickets with a labelField (subject) — the leak target
    const t = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "subject", label: "S", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
        { name: "org", label: "Org", type: "text", publicRead: true },
      ],
      access: { read: "authenticated", write: "owner", ownerField: "owner", org: { claim: "org_id", field: "org" } },
    });
    assert.ok(t.ok, t.errorText);

    // NON-org comments that relate to org-scoped tickets — the leak channel: the
    // parent row is visible cross-org, only the resolved label must be masked.
    const c = await mcp(p.mcpToken, "define_collection", {
      name: "comments",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
        { name: "ticket", label: "Ticket", type: "relation", targetCollection: "tickets", labelField: "subject", publicRead: true },
      ],
      access: { read: "authenticated", write: "authenticated", ownerField: "owner" },
    });
    assert.ok(c.ok, c.errorText);
  });
  after(async () => {
    await issuer.close();
    await p.destroy();
  });

  it("Fix A (define-time): owner-scoped + anonymous write (publicWrite) is rejected", async () => {
    const bad = await mcp(p.mcpToken, "define_collection", {
      name: "tips",
      publicWrite: true,
      fields: [
        { name: "owner", label: "O", type: "text", publicRead: true },
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
      ],
      access: { read: "owner", write: "none", ownerField: "owner" },
    });
    assert.ok(!bad.ok && /cannot accept anonymous writes/.test(bad.errorText), bad.errorText);
  });

  it("Fix A (runtime strip): an anonymous forged ownerField is dropped, never stored", async () => {
    // A publicWrite collection that carries an ownerField but is NOT owner-scoped
    // (so it passes define-time). An anonymous POST forging owner must be stripped.
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "guestbook",
      publicWrite: true,
      fields: [
        { name: "owner", label: "O", type: "text", publicRead: true },
        { name: "msg", label: "M", type: "text", required: true, publicRead: true },
      ],
      access: { read: "public", write: "none", ownerField: "owner" },
    });
    assert.ok(def.ok, def.errorText);
    const r = await delivery(p.deliveryToken, "/guestbook", { method: "POST", body: { msg: "hi", owner: "u_victim" } });
    assert.equal(r.status, 201);
    const row = await mcp(p.mcpToken, "get_entry", { collection: "guestbook", id: r.json.id });
    assert.ok(row.ok, row.errorText);
    assert.equal(row.value.data.owner ?? null, null, "forged owner must be stripped on the anonymous path");
  });

  it("Fix B: a cross-org viewer never sees an org-scoped relation label", async () => {
    // Trusted setup: an acme ticket + a comment referencing it.
    const ticket = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { subject: "Acme secret subject", owner: "u_acme", org: "acme" } });
    assert.ok(ticket.ok, ticket.errorText);
    const comment = await mcp(p.mcpToken, "create_entry", { collection: "comments", data: { body: "see ticket", owner: "u_acme", ticket: ticket.value.id } });
    assert.ok(comment.ok, comment.errorText);

    // globex sees the comment (comments not org-scoped) but NOT the acme subject.
    const gList = await delivery(p.deliveryToken, "/comments", { userToken: globex });
    assert.equal(gList.status, 200);
    const gRow = gList.json.data.find((x) => x.id === comment.value.id);
    assert.ok(gRow, "comment row should be visible to globex (comments not org-scoped)");
    assert.equal(gRow.ticket.id, ticket.value.id);
    assert.equal(gRow.ticket.label, ticket.value.id, "cross-org label must fall back to the id — no subject leak");

    // acme (same org) DOES see the real label; MCP (trusted) always does.
    const aList = await delivery(p.deliveryToken, "/comments", { userToken: acme });
    const aRow = aList.json.data.find((x) => x.id === comment.value.id);
    assert.equal(aRow.ticket.label, "Acme secret subject", "same-org viewer sees the real label");
    const mRow = await mcp(p.mcpToken, "get_entry", { collection: "comments", id: comment.value.id });
    assert.equal(mRow.value.data.ticket.label, "Acme secret subject");
  });

  it("Fix B (single GET): cross-org relation label is also masked on /{id}", async () => {
    const ticket = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { subject: "Another secret", owner: "u_acme", org: "acme" } });
    const comment = await mcp(p.mcpToken, "create_entry", { collection: "comments", data: { body: "x", owner: "u_acme", ticket: ticket.value.id } });
    const g = await delivery(p.deliveryToken, `/comments/${comment.value.id}`, { userToken: globex });
    assert.equal(g.status, 200);
    assert.equal(g.json.data.ticket.label, ticket.value.id, "no subject leak on single GET");
  });

  it("Fix C: PATCH is rate-limited (429 within one window for a single IP)", async () => {
    const created = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { subject: "rl", owner: "u_acme", org: "acme" } });
    const id = created.value.id;
    const ip = "10.77.77.77";
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await delivery(p.deliveryToken, `/tickets/${id}`, { method: "PATCH", body: { subject: `e${i}` }, userToken: acme, ip });
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, "expected a 429 within 25 rapid PATCHes from one IP");
  });
});
