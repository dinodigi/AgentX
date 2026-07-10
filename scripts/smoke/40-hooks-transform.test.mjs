import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import {
  ensureServer,
  createEphemeralProject,
  startHookReceiver,
  startMockIssuer,
  connectClerk,
  mcp,
  delivery,
} from "./helpers.mjs";

// I1b: transform mode + beforeUpdate. A transform rewrites the candidate; its
// FULL output is re-validated and ownership is re-stamped/preserved so a hook
// can never move ownership. transform is https-only (loopback excepted).
const sql = neon(process.env.DATABASE_URL);
const th = (url, stage, mode = "transform", extra = {}) => ({ [stage]: { url, mode, timeoutMs: 700, ...extra } });

describe("transform + beforeUpdate hooks (I1b)", () => {
  let p, rcv;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("hooks-transform");
    rcv = await startHookReceiver();
  });
  after(async () => {
    await rcv.close();
    await p.destroy();
  });

  it("beforeCreate transform rewrites the candidate (full-data replace)", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "widgets",
      fields: [
        { name: "name", label: "N", type: "text", required: true, publicRead: true },
        { name: "slug", label: "S", type: "text", publicRead: true },
      ],
      hooks: th(rcv.url, "beforeCreate"),
    });
    assert.ok(def.ok, def.errorText);
    rcv.transform({ name: "Normalized", slug: "normalized" });
    const c = await mcp(p.mcpToken, "create_entry", { collection: "widgets", data: { name: "raw INPUT" } });
    assert.ok(c.ok, c.errorText);
    const g = await mcp(p.mcpToken, "get_entry", { collection: "widgets", id: c.value.id });
    assert.equal(g.value.data.name, "Normalized", "transform rewrote name");
    assert.equal(g.value.data.slug, "normalized", "transform added slug");
  });

  it("a transform CANNOT move ownership on create — owner is re-stamped from the verified identity", async () => {
    const issuer = await startMockIssuer();
    const owned = await createEphemeralProject("hooks-owner");
    const r2 = await startHookReceiver();
    try {
      await connectClerk(owned.id, issuer.issuer);
      const def = await mcp(owned.mcpToken, "define_collection", {
        name: "notes",
        fields: [
          { name: "body", label: "B", type: "text", required: true, publicRead: true },
          { name: "owner", label: "O", type: "text" },
        ],
        access: { read: "owner", write: "owner", ownerField: "owner" },
        hooks: th(r2.url, "beforeCreate"),
      });
      assert.ok(def.ok, def.errorText);
      // The hook tries to write the note under a DIFFERENT owner.
      r2.transform({ body: "hijacked", owner: "user_attacker" });
      const alice = await issuer.tokenFor("user_alice");
      const res = await delivery(owned.deliveryToken, "/notes", { method: "POST", body: { body: "mine" }, userToken: alice });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      const g = await mcp(owned.mcpToken, "get_entry", { collection: "notes", id: res.json.id });
      assert.equal(g.value.data.body, "hijacked", "transform applied to non-identity fields");
      assert.equal(g.value.data.owner, "user_alice", "OWNER re-stamped to the verified user, not the hook's value");
    } finally {
      await r2.close();
      await owned.destroy();
      await issuer.close();
    }
  });

  it("beforeUpdate validate gates updates (reject → E_HOOK_REJECTED, approve → applies)", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "state", label: "S", type: "text", publicRead: true },
      ],
      hooks: th(rcv.url, "beforeUpdate", "validate"),
    });
    assert.ok(def.ok, def.errorText);
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "T1", state: "open" } });
    rcv.reject("update not allowed");
    const bad = await mcp(p.mcpToken, "update_entry", { collection: "tickets", id: c.value.id, data: { state: "closed" } });
    assert.ok(!bad.ok && /E_HOOK_REJECTED/.test(bad.errorText), bad.errorText);
    rcv.approve();
    const ok = await mcp(p.mcpToken, "update_entry", { collection: "tickets", id: c.value.id, data: { state: "closed" } });
    assert.ok(ok.ok, ok.errorText);
    assert.equal(ok.value.data.state, "closed");
  });

  it("beforeUpdate transform replaces the entry with the full returned data (dropped keys unset)", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "note", label: "N", type: "text", publicRead: true },
      ],
      hooks: th(rcv.url, "beforeUpdate"),
    });
    assert.ok(def.ok, def.errorText);
    rcv.approve();
    const c = await mcp(p.mcpToken, "create_entry", { collection: "docs", data: { title: "Orig", note: "keep me" } });
    // Transform returns FULL data WITHOUT `note` → note must be unset (full replace).
    rcv.transform({ title: "Rewritten" });
    const u = await mcp(p.mcpToken, "update_entry", { collection: "docs", id: c.value.id, data: { title: "ignored-by-transform" } });
    assert.ok(u.ok, u.errorText);
    assert.equal(u.value.data.title, "Rewritten");
    assert.ok(!("note" in u.value.data), "a key the transform dropped is unset (full-data replace)");
  });

  it("transform beforeUpdate on a row in a source-only workflow state does not spuriously fail (review #A)", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "status", label: "S", type: "enum", options: ["draft", "published"], publicRead: true },
      ],
      workflow: { field: "status", initial: "draft", transitions: [{ from: "draft", to: "published" }] },
      hooks: th(rcv.url, "beforeUpdate"),
    });
    assert.ok(def.ok, def.errorText);
    const c = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "A" } }); // status=draft
    // The transform echoes the FULL entry incl status:'draft' (a source-only state,
    // never a transition target). Before the fix this failed "not a transition target".
    rcv.transform({ title: "Normalized", status: "draft" });
    const u = await mcp(p.mcpToken, "update_entry", { collection: "posts", id: c.value.id, data: { title: "raw" } });
    assert.ok(u.ok, "update of a draft row must not fail on the unchanged workflow field: " + u.errorText);
    assert.equal(u.value.data.status, "draft");
    // A transform that DOES move the state still transitions (draft→published is valid).
    rcv.transform({ title: "Live", status: "published" });
    const u2 = await mcp(p.mcpToken, "update_entry", { collection: "posts", id: c.value.id, data: { title: "x" } });
    assert.ok(u2.ok, u2.errorText);
    assert.equal(u2.value.data.status, "published", "a legit transition via transform still applies");
  });

  it("transform beforeCreate inside transact accepts a same-batch $ref (review #C)", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "authors2",
      fields: [{ name: "name", label: "N", type: "text", required: true, publicRead: true }],
    });
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "books2",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "author", label: "A", type: "relation", targetCollection: "authors2", labelField: "name", publicRead: true },
      ],
      hooks: th(rcv.url, "beforeCreate"),
    });
    assert.ok(def.ok, def.errorText);
    rcv.echo(); // no-op transform, but still re-verifyRefs the (resolved) $ref
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "authors2", ref: "a1", data: { name: "Ada" } },
        { op: "create", collection: "books2", data: { title: "Book", author: "$ref:a1" } },
      ],
    });
    assert.ok(r.ok, "same-batch $ref must resolve through a transform's re-verifyRefs: " + r.errorText);
  });

  it("an IPv6-loopback [::1] http transform URL is accepted (review #D)", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "ipv6hook",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
      hooks: { beforeCreate: { url: "http://[::1]:9999/hook", mode: "transform" } },
    });
    assert.ok(r.ok, "http://[::1] must be accepted as loopback: " + r.errorText);
  });

  it("transform mode is https-only for non-loopback URLs", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "nope",
      fields: [{ name: "x", label: "X", type: "text", required: true }],
      hooks: { beforeCreate: { url: "http://hooks.example.com/t", mode: "transform" } },
    });
    assert.ok(!r.ok && /https for transform/.test(r.errorText), r.errorText);
  });

  it("manifest import downgrades hooks to disabled + warns when the project has no signing secret", async () => {
    // Source project with a hook; export it.
    const src = await createEphemeralProject("hooks-export");
    const target = await createEphemeralProject("hooks-import");
    try {
      await mcp(src.mcpToken, "define_collection", {
        name: "gated",
        fields: [{ name: "title", label: "T", type: "text", required: true }],
        hooks: th(rcv.url, "beforeCreate", "validate"),
      });
      const manifest = await mcp(src.mcpToken, "export_project", {});
      assert.ok(manifest.ok, manifest.errorText);
      // Target has NO signing secret → import must downgrade, not hard-fail.
      await sql`UPDATE projects SET webhook_signing_secret = NULL WHERE id = ${target.id}`;
      const imp = await mcp(target.mcpToken, "import_project", { manifest: manifest.value, confirm: true });
      assert.ok(imp.ok, imp.errorText);
      assert.ok(imp.value.warnings?.some((w) => /gated.*disabled/i.test(w)), JSON.stringify(imp.value.warnings));
      const d = await mcp(target.mcpToken, "describe_collection", { name: "gated" });
      assert.equal(d.value.hooks.beforeCreate.disabled, true, "imported hook is disabled");
    } finally {
      await src.destroy();
      await target.destroy();
    }
  });
});
