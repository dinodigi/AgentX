import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { ensureServer, createEphemeralProject, BASE, sql } from "./helpers.mjs";

// DX-6 / D3 — MCP OAuth (OAuth 2.1 + RFC 8414 + 7591 + 9728 + PKCE + 8707).
//
// The consent PAGE needs a Clerk session, so it is verified by hand. Everything
// a machine can reach is covered here: discovery, the 401 bootstrap, dynamic
// registration, and the token endpoint's security properties — which are the
// parts where a mistake is silent and expensive.
describe("MCP OAuth (DX-6/D3)", () => {
  let p;
  const pkce = () => {
    const verifier = randomBytes(48).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };

  const form = (o) =>
    fetch(`${BASE}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(o),
    });

  async function register(redirectUris = ["http://localhost:9876/callback"]) {
    const res = await fetch(`${BASE}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris, client_name: "Smoke Client" }),
    });
    return { status: res.status, body: await res.json() };
  }

  /** Plant an approved code directly — stands in for the human consent step. */
  async function plantCode({ clientId, redirectUri, challenge, scopes = ["content.read"], expired = false, used = false }) {
    const raw = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(raw).digest("hex");
    await sql`INSERT INTO oauth_codes
      (code_hash, client_id, redirect_uri, code_challenge, resource, project_id, scopes, approved_by, expires_at, used_at)
      VALUES (${hash}, ${clientId}, ${redirectUri}, ${challenge}, null, ${p.id},
              ${JSON.stringify(scopes)}::jsonb, 'user_smoke',
              ${expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 300_000)},
              ${used ? new Date() : null})`;
    return raw;
  }

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("oauth");
  });
  after(() => p.destroy());

  it("RFC 9728: a 401 from the MCP endpoint points at the resource metadata", async () => {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
    const wa = res.headers.get("www-authenticate");
    assert.ok(wa, "WWW-Authenticate is the entire discovery bootstrap");
    assert.match(wa, /Bearer/);
    assert.match(wa, /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/);
  });

  it("RFC 9728: protected-resource metadata names an authorization server", async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.ok(Array.isArray(m.authorization_servers) && m.authorization_servers.length >= 1);
    assert.match(m.resource, /\/api\/mcp$/, "canonical resource identifier (RFC 8707)");
    assert.ok(m.scopes_supported.includes("content.read"));
  });

  it("RFC 8414: authorization-server metadata advertises S256-only PKCE", async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.match(m.authorization_endpoint, /\/oauth\/authorize$/);
    assert.match(m.token_endpoint, /\/api\/oauth\/token$/);
    assert.match(m.registration_endpoint, /\/api\/oauth\/register$/);
    assert.deepEqual(m.code_challenge_methods_supported, ["S256"], "plain PKCE must never be offered");
    assert.deepEqual(m.grant_types_supported, ["authorization_code"]);
    assert.deepEqual(m.response_types_supported, ["code"]);
  });

  it("RFC 7591: dynamic registration issues a public client", async () => {
    const { status, body } = await register();
    assert.equal(status, 201);
    assert.match(body.client_id, /^pc_/);
    assert.equal(body.client_secret, undefined, "public client — no secret is issued");
    assert.equal(body.token_endpoint_auth_method, "none");
  });

  it("registration refuses redirect URIs that could leak a code", async () => {
    for (const bad of ["http://evil.example.com/cb", "ftp://x/cb", "https://ok.example.com/cb#frag"]) {
      const { status, body } = await register([bad]);
      assert.equal(status, 400, `must reject ${bad}`);
      assert.equal(body.error, "invalid_redirect_uri");
    }
    // https anywhere, and http ONLY on loopback (native clients need it).
    assert.equal((await register(["https://app.example.com/cb"])).status, 201);
    assert.equal((await register(["http://127.0.0.1:1234/cb"])).status, 201);
  });

  it("the happy path: code + verifier → a scoped, expiring access token", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const redirectUri = client.redirect_uris[0];
    const code = await plantCode({ clientId: client.client_id, redirectUri, challenge, scopes: ["content.read", "observability.read"] });

    const res = await form({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const t = await res.json();
    assert.equal(res.status, 200, JSON.stringify(t));
    assert.match(t.access_token, /^agx_/, "issued into the existing token system");
    assert.equal(t.token_type, "Bearer");
    assert.ok(t.expires_in > 0, "OAuth tokens EXPIRE — unlike console-minted ones");
    assert.equal(t.scope, "content.read observability.read");

    // And it actually works on the MCP surface, limited to what was granted.
    const ok = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_collections", arguments: {} } }),
    });
    const okBody = await ok.json();
    assert.ok(!okBody.result?.isError, "observability.read was granted");

    const denied = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "define_collection", arguments: { name: "nope", fields: [{ name: "x", label: "X", type: "text" }] } },
      }),
    });
    const deniedBody = await denied.json();
    assert.ok(deniedBody.result?.isError, "schema.manage was NOT granted — D2 enforcement applies to OAuth tokens");
    assert.match(deniedBody.result.content[0].text, /schema\.manage/);
  });

  it("PKCE: a wrong verifier is refused", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const other = pkce();
    const code = await plantCode({ clientId: client.client_id, redirectUri: client.redirect_uris[0], challenge });
    const res = await form({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_verifier: other.verifier,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_grant");
  });

  it("a code is SINGLE-USE — replay is refused", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const args = { clientId: client.client_id, redirectUri: client.redirect_uris[0], challenge };
    const code = await plantCode(args);
    const base = {
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_verifier: verifier,
    };
    assert.equal((await form(base)).status, 200);
    const replay = await form(base);
    assert.equal(replay.status, 400, "the second redemption must fail");
    assert.equal((await replay.json()).error, "invalid_grant");
  });

  it("a code cannot be redeemed by a different client, or to a different redirect", async () => {
    const { body: mine } = await register();
    const { body: attacker } = await register(["https://attacker.example.com/cb"]);
    const { verifier, challenge } = pkce();
    const code = await plantCode({ clientId: mine.client_id, redirectUri: mine.redirect_uris[0], challenge });

    const wrongClient = await form({
      grant_type: "authorization_code", code,
      client_id: attacker.client_id,
      redirect_uri: attacker.redirect_uris[0],
      code_verifier: verifier,
    });
    assert.equal(wrongClient.status, 400, "client binding must hold");

    const wrongRedirect = await form({
      grant_type: "authorization_code", code,
      client_id: mine.client_id,
      redirect_uri: "https://attacker.example.com/cb",
      code_verifier: verifier,
    });
    assert.equal(wrongRedirect.status, 400, "redirect binding must hold");
  });

  it("an expired code is refused", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const code = await plantCode({ clientId: client.client_id, redirectUri: client.redirect_uris[0], challenge, expired: true });
    const res = await form({
      grant_type: "authorization_code", code,
      client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier,
    });
    assert.equal(res.status, 400);
  });

  it("RFC 8707: a mismatched resource is refused (no silent audience confusion)", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const code = await plantCode({ clientId: client.client_id, redirectUri: client.redirect_uris[0], challenge });
    const res = await form({
      grant_type: "authorization_code", code,
      client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_verifier: verifier,
      resource: "https://someone-elses-mcp.example.com/mcp",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_target");
  });

  it("unsupported grants are named, not silently ignored", async () => {
    const res = await form({ grant_type: "client_credentials", client_id: "x" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unsupported_grant_type");
  });
});
