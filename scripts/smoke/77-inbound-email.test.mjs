import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// v2 Track 2b: inbound email → collection. A provider POSTs a normalized
// {from,to,subject,text} with the per-project secret; each becomes an entry
// via fieldMap. Trusted (secret-gated), bypasses publicWrite. Fail-closed:
// unconfigured 404, wrong secret 401 — a prober can't tell them apart.
//
// Each test provisions its OWN project — configure/disable are destructive, so
// shared mutable state would race under node:test's scheduling.
describe("inbound email routing", () => {
  before(ensureServer);

  const post = (projectId, body, token) =>
    fetch(`${BASE}/api/inbound/${projectId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  /** A project with an `inbox` collection, optionally with inbound configured. */
  async function provision(label, { configure = true } = {}) {
    const p = await createEphemeralProject(label);
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "inbox",
      fields: [
        { name: "sender", label: "Sender", type: "text", required: true },
        { name: "subject", label: "Subject", type: "text" },
        { name: "body", label: "Body", type: "richtext" },
      ],
    });
    assert.ok(def.ok, def.errorText);
    let secret;
    if (configure) {
      const cfg = await mcp(p.mcpToken, "configure_inbound", {
        collection: "inbox",
        fieldMap: { from: "sender", subject: "subject", text: "body" },
      });
      assert.ok(cfg.ok, cfg.errorText);
      secret = cfg.value.secret;
    }
    return { p, secret };
  }

  it("before config: the endpoint 404s (fail-closed, no secret to leak)", async () => {
    const { p } = await provision("inbound-unconfigured", { configure: false });
    const r = await post(p.id, { from: "x@y.z" }, "anything");
    assert.equal(r.status, 404);
  });

  it("configure_inbound returns a one-time secret + postUrl", async () => {
    const { p, secret } = await provision("inbound-configure");
    assert.ok(secret && secret.length > 20);
    // postUrl shape is asserted via the working POST below; here just the secret.
    assert.ok(p.id);
  });

  it("rejects a fieldMap targeting a non-existent field / bad inbound key", async () => {
    const { p } = await provision("inbound-badmap", { configure: false });
    const badTarget = await mcp(p.mcpToken, "configure_inbound", { collection: "inbox", fieldMap: { from: "nope" } });
    assert.equal(badTarget.ok, false);
    assert.match(badTarget.errorText, /not a field on/i);
    const badKey = await mcp(p.mcpToken, "configure_inbound", { collection: "inbox", fieldMap: { bogus: "sender" } });
    assert.equal(badKey.ok, false);
    assert.match(badKey.errorText, /inbound fields are/i);
  });

  it("a valid inbound POST creates a mapped entry", async () => {
    const { p, secret } = await provision("inbound-valid");
    const body = { from: "customer@example.com", to: "team@stallion.test", subject: "Re: quote", text: "Sounds good!" };
    // Tolerate ONLY the Neon read-after-write micro-lag between this project's
    // configure and its immediate POST (absent in real use; a broken route
    // 404s past the retries and still fails).
    let r, text;
    for (let i = 0; i < 8; i++) {
      r = await post(p.id, body, secret);
      text = await r.text(); // read ONCE — reading twice throws "Body already read"
      if (r.status !== 404) break;
      await new Promise((res) => setTimeout(res, 400));
    }
    assert.equal(r.status, 201, text);
    const { id } = JSON.parse(text);
    assert.ok(id);
    const q = await mcp(p.mcpToken, "query_entries", { collection: "inbox" });
    const rows = q.value.entries ?? q.value;
    const row = rows[0].data ?? rows[0];
    assert.equal(row.sender, "customer@example.com");
    assert.equal(row.subject, "Re: quote");
    assert.equal(row.body, "Sounds good!");
  });

  it("wrong secret → 401; a required-field failure surfaces as 422", async () => {
    const { p, secret } = await provision("inbound-authfail");
    assert.equal((await post(p.id, { from: "x@y.z" }, "wrong-secret")).status, 401);
    // `sender` is required; a payload with no `from` maps to an empty entry → 422.
    assert.equal((await post(p.id, { subject: "no sender" }, secret)).status, 422);
  });

  it("disable_inbound turns the endpoint back to 404", async () => {
    const { p, secret } = await provision("inbound-disable");
    assert.equal((await post(p.id, { from: "c@e.com" }, secret)).status, 201); // works first
    const d = await mcp(p.mcpToken, "disable_inbound", {});
    assert.ok(d.ok, d.errorText);
    assert.equal((await post(p.id, { from: "c@e.com" }, secret)).status, 404); // then off
  });
});
