import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// D3 — the browser-safe delivery token.
//
// XVibe ran an edge proxy PER APP solely to keep a token off the client, and
// after the domain split every deployed app became a distinct cross-origin
// caller — so that proxy became the default shape of every site we ship.
//
// The reframe: a read-only token grants exactly what publicRead already exposes
// to the anonymous internet. If that data is public, a leak leaks nothing new.
// What it costs is ABUSE, which is rate-limiting and revocation.

describe("D3 — read-only delivery token", () => {
  let p, ro;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("readonly-token");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      publicWrite: true,
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "seed" } });
    const r = await mcp(p.mcpToken, "mint_delivery_token", {
      label: "browser bundle",
      readOnly: true,
    });
    assert.ok(r.ok, r.errorText);
    ro = r.value.token;
    assert.ok(ro, "the raw token is returned once");
  });
  after(() => p.destroy());

  it("THE POINT: it can READ — that is the whole reason it exists", async () => {
    const res = await delivery(ro, "/posts");
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.data[0].title, "seed");
  });

  it("...and a single row too", async () => {
    const list = await delivery(ro, "/posts");
    const res = await delivery(ro, `/posts/${list.json.data[0].id}`);
    assert.equal(res.status, 200);
  });

  it("POST is refused, even on a publicWrite collection", async () => {
    // publicWrite means anyone may submit — but not with THIS token, because a
    // browser-embeddable write endpoint is a spam surface that needs its own
    // human-verification story first.
    const res = await delivery(ro, "/posts", { method: "POST", body: { title: "nope" } });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /READ-ONLY/);
    assert.match(res.json.error, /server-side/, "the error must name the actual fix");
    assert.equal(res.json.code, "E_SCOPE");
  });

  it("PATCH and DELETE are refused", async () => {
    const list = await delivery(ro, "/posts");
    const id = list.json.data[0].id;
    const patched = await delivery(ro, `/posts/${id}`, { method: "PATCH", body: { title: "x" } });
    assert.equal(patched.status, 403);
    const deleted = await delivery(ro, `/posts/${id}`, { method: "DELETE" });
    assert.equal(deleted.status, 403);
  });

  it("uploads are refused", async () => {
    const res = await fetch(
      `${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/posts/uploads`,
      { method: "POST", headers: { authorization: `Bearer ${ro}` } },
    );
    assert.equal(res.status, 403);
  });

  it("THE GRANDFATHER RULE: an ordinary delivery token still writes", async () => {
    // Existing tokens carry scopes = null, which means full access. If this
    // broke, every deployed site on the platform would break with it.
    const res = await delivery(p.deliveryToken, "/posts", {
      method: "POST",
      body: { title: "from a full token" },
    });
    assert.ok([200, 201].includes(res.status), `${res.status} ${JSON.stringify(res.json)}`);
  });

  it("a read-only token is still project-scoped and revocable like any other", async () => {
    const list = await mcp(p.mcpToken, "list_delivery_tokens", {});
    assert.ok(list.ok, list.errorText);
    const row = list.value.find((t) => t.label === "browser bundle");
    assert.ok(row, "it must appear in the token list, or a human cannot revoke it");
    // And it must be DISTINGUISHABLE. Without this flag a human managing tokens
    // cannot tell a browser-safe credential from one that must never leave a
    // server — the exact distinction this feature exists to make.
    assert.equal(row.readOnly, true);
    assert.ok(
      list.value.some((t) => t.readOnly === false),
      "a full token must read as readOnly:false, not undefined",
    );
  });
});
