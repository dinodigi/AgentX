import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery, sql } from "./helpers.mjs";

// Friction sprint A1: the MCP AUTHORING surface reads collections FRESH — an
// agent always sees its own writes, immediately. Two Codex field reports
// (2026-07-23) were this class: "deletion reports success but the collection
// remains visible", "searchable not picked up after redefine". Both were the
// 15s cross-instance cache window, invisible single-instance — so this test
// makes the window VISIBLE on one instance: warm the cache through the app,
// mutate the DB directly underneath it (as "another instance" effectively
// does), then demand the MCP surface report the change with NO wait. A cached
// read would serve the pre-mutation answer for up to TTL+SWR; fresh must not.
describe("MCP fresh reads (friction A1)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("fresh-reads");
  });
  after(() => p.destroy());

  it("list_collections sees an under-the-cache delete with zero wait", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "ghost",
      fields: [{ name: "x", label: "X", type: "text" }],
    });
    // Warm every cache layer through the app.
    const warm = await mcp(p.mcpToken, "list_collections", {});
    assert.ok(warm.value.some((c) => c.name === "ghost"));

    // Mutate UNDER the cache — no revalidateTag fires, exactly like a write
    // that happened on a different instance.
    await sql`DELETE FROM collections WHERE project_id = ${p.id} AND name = 'ghost'`;

    const now = await mcp(p.mcpToken, "list_collections", {});
    assert.equal(
      now.value.some((c) => c.name === "ghost"),
      false,
      "a cached read would still show 'ghost' — the MCP surface must not",
    );
  });

  it("mustCollection (schema-dependent tools) sees an under-the-cache config change", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "body", label: "B", type: "richtext" },
      ],
    });
    // Warm the per-collection cache via a tool that resolves it.
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "t1", body: "<p>wonderful prose</p>" } });

    // Flip searchable:true directly in the DB — the redefine-from-elsewhere shape.
    const [row] = await sql`SELECT fields FROM collections WHERE project_id = ${p.id} AND name = 'posts'`;
    const fields = row.fields.map((f) => (f.name === "body" ? { ...f, searchable: true } : f));
    await sql`UPDATE collections SET fields = ${JSON.stringify(fields)}::jsonb WHERE project_id = ${p.id} AND name = 'posts'`;

    // search_entries gates on collection config; a cached read answers
    // "search is not enabled" for up to TTL. Fresh must search NOW.
    const r = await mcp(p.mcpToken, "search_entries", { collection: "posts", q: "wonderful" });
    assert.ok(r.ok, `search must be enabled immediately after the config change: ${r.errorText}`);
    assert.ok((r.value.entries?.length ?? r.value.length) >= 1, "and must find the row");
  });

  it("mutation results carry the A2 convergence note", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "noted",
      fields: [{ name: "x", label: "X", type: "text" }],
    });
    assert.match(def.value.convergence, /immediately/);
    assert.match(def.value.convergence, /15s/);

    const del = await mcp(p.mcpToken, "delete_collection", { name: "noted", confirm: true });
    assert.ok(del.ok, del.errorText);
    assert.match(del.value.convergence, /immediately/);
  });
});

// Friction sprint Track C: the delivery on-ramp survives a browser dev.
// Field case: Codex burned a Replit session on "404 for every endpoint" —
// a wrong path shape, undiagnosable from a bare `{"error":"not found"}`.
describe("delivery on-ramp (friction C)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("onramp");
    await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
  });
  after(() => p.destroy());

  it("C1: an AUTHENTICATED 404 names the project's public collections + the path shape", async () => {
    const r = await delivery(p.deliveryToken, "/no_such_thing");
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no collection "no_such_thing"/);
    assert.match(r.json.error, /articles/, "names what DOES exist");
    assert.match(r.json.error, /\{base\}\/api\/v1\/\{collection\}/, "teaches the path shape");
  });

  it("C1 guard: anonymous callers get a bare 401 — no enumeration", async () => {
    const res = await fetch(`${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/no_such_thing`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.doesNotMatch(body.error ?? "", /articles/, "collection names never leak to the unauthenticated");
  });

  it("C2: the generated client ships verifyConnection with the _health-first probe", async () => {
    const r = await mcp(p.mcpToken, "get_client_code", {});
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.code, /async verifyConnection\(\)/);
    assert.match(r.value.code, /\/_health/, "probes the unauthenticated liveness endpoint first");
    assert.match(r.value.code, /base URL is wrong/, "diagnoses the exact Codex failure mode");
    assert.match(r.value.code, /curl .*_health/, "header carries the shell equivalent");
  });
});

// LearnLab field case (07-23): included[0] was owner-only, the probe hit it,
// and verifyConnection reported failure on a HEALTHY connection. The probe
// must target a collection readable with the delivery token ALONE, and an
// authenticated 404 on an existing-but-private collection must say why.
describe("verifyConnection probe targeting (friction C2 follow-up)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("probe-pick");
    // FIRST collection: create-only shape, zero public fields (included[0]).
    await mcp(p.mcpToken, "define_collection", {
      name: "a_private_inbox",
      publicWrite: true,
      fields: [{ name: "note", label: "N", type: "text", required: true }],
    });
    // SECOND: genuinely public — the probe must pick THIS one.
    await mcp(p.mcpToken, "define_collection", {
      name: "z_public_posts",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
  });
  after(() => p.destroy());

  it("the generated probe targets the delivery-readable collection, not included[0]", async () => {
    const r = await mcp(p.mcpToken, "get_client_code", {});
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.code, /fetch\(baseUrl \+ "\/z_public_posts" \+ "\?limit=1"/, "probe picks the public collection");
    assert.match(r.value.code, /curl .*z_public_posts\?limit=1/, "header curl agrees with the probe");
  });

  it("an authenticated 404 on an existing private collection says WHY", async () => {
    const r = await delivery(p.deliveryToken, "/a_private_inbox");
    assert.equal(r.status, 404);
    assert.match(r.json.error, /exists but has no publicly readable fields/);
    assert.match(r.json.error, /publicRead is per-field/);
  });

  it("a JSON 404 on the probe is diagnosed as CONNECTED (auth proven), not failure", async () => {
    const r = await mcp(p.mcpToken, "get_client_code", {});
    assert.match(r.value.code, /connected and authenticated — but the probe collection no longer exists/);
  });
});
