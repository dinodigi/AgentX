import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";
import { migrationHeaders, migrationNotice, successorBase } from "../../lib/migration-notice.ts";

// Host migration notice. The machinery ships BEFORE the new domain exists, so
// the property that matters most is silence: a notice pointing at a host that
// does not resolve would send integrators chasing an instruction they cannot
// follow. Live behaviour is asserted against the pure functions (env-driven);
// the running server is asserted to be quiet, which is its configured state.

describe("migration notice — silent until configured", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("migration");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "t", label: "T", type: "text", required: true, publicRead: true }],
    });
  });
  after(() => p.destroy());

  it("UNCONFIGURED: get_project_info carries no migration key at all", async () => {
    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(info.ok, info.errorText);
    assert.equal(
      "migration" in info.value,
      false,
      "an empty/absent migration key must be OMITTED — a blank one reads as 'something is wrong here'",
    );
  });

  it("UNCONFIGURED: delivery responses carry no deprecation headers", async () => {
    const res = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/posts`, {
      headers: { authorization: `Bearer ${p.deliveryToken}` },
    });
    assert.equal(res.headers.get("deprecation"), null);
    assert.equal(res.headers.get("sunset"), null);
    assert.equal(res.headers.get("link"), null);
  });

  it("a MALFORMED successor stays silent rather than emitting a broken instruction", () => {
    const prev = process.env.SUCCESSOR_API_BASE;
    process.env.SUCCESSOR_API_BASE = "not a url";
    try {
      assert.equal(successorBase(), null);
      assert.deepEqual(migrationHeaders("https://old.example/api/v1/posts"), {});
      assert.equal(migrationNotice("https://old.example"), null);
    } finally {
      if (prev === undefined) delete process.env.SUCCESSOR_API_BASE;
      else process.env.SUCCESSOR_API_BASE = prev;
    }
  });

  it("CONFIGURED: RFC 8594 headers, with the path preserved in Link", () => {
    const prev = process.env.SUCCESSOR_API_BASE;
    process.env.SUCCESSOR_API_BASE = "https://api.plugster.dev";
    try {
      const h = migrationHeaders("https://pluggie.app/api/v1/posts?limit=2");
      assert.equal(h.deprecation, "true");
      assert.match(h.warning, /api\.plugster\.dev/);
      // The successor Link must point at the SAME resource, or it is a
      // deprecation notice that does not tell you where your data went.
      assert.equal(h.link, '<https://api.plugster.dev/api/v1/posts?limit=2>; rel="successor-version"');
    } finally {
      if (prev === undefined) delete process.env.SUCCESSOR_API_BASE;
      else process.env.SUCCESSOR_API_BASE = prev;
    }
  });

  it("CONFIGURED: the agent notice says nothing is breaking, and how to move", () => {
    const prev = process.env.SUCCESSOR_API_BASE;
    process.env.SUCCESSOR_API_BASE = "https://api.plugster.dev";
    try {
      const note = migrationNotice("https://pluggie.app");
      assert.match(note, /DEPRECATED/);
      assert.match(note, /no call will start failing/i, "an agent must not read this as an outage");
      assert.match(note, /createClient\(\{ baseUrl/, "and must be told the exact one-line fix");
    } finally {
      if (prev === undefined) delete process.env.SUCCESSOR_API_BASE;
      else process.env.SUCCESSOR_API_BASE = prev;
    }
  });

  it("a sunset date is optional — deprecation without an end date is valid", () => {
    const prev = process.env.SUCCESSOR_API_BASE;
    process.env.SUCCESSOR_API_BASE = "https://api.plugster.dev";
    delete process.env.SUCCESSOR_SUNSET;
    try {
      const h = migrationHeaders();
      assert.equal(h.deprecation, "true");
      assert.equal(h.sunset, undefined, "no date announced is better than a date we cannot keep");
    } finally {
      if (prev === undefined) delete process.env.SUCCESSOR_API_BASE;
      else process.env.SUCCESSOR_API_BASE = prev;
    }
  });
});
