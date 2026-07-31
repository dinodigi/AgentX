import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// CP-A of the XVibe intake sprint.
//
// 110a — the notSupported registry (wall 2479b787): served in the briefing, and
// SELF-CHECKING. The list that motivated this feature was stale in two places
// when it was filed; the only thing keeping THIS list honest is a test that
// cross-examines it against the backlog the same way `npm run pm` cross-examines
// receipts against git.
//
// 110b — the publicRead trap (wall 21f4c5d5): a gated-read define now says, in
// its own response, that publicRead still gates fields for authenticated
// readers, and names the hidden fields.

describe("notSupported registry (2479b787)", () => {
  let p;
  let registry;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("not-supported");
    const r = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(r.ok, r.errorText);
    registry = r.value.briefing?.notSupported;
  });
  after(() => p.destroy());

  it("is served in the briefing, with the full entry shape", () => {
    assert.ok(Array.isArray(registry) && registry.length > 0, "briefing.notSupported must exist");
    for (const e of registry) {
      assert.ok(e.capability?.length > 10, `capability text: ${JSON.stringify(e)}`);
      assert.ok(["not_supported", "scheduled", "declined"].includes(e.status), e.status);
      assert.ok(e.alternative?.length > 10, `every entry must give the agent a next move: ${e.capability}`);
      assert.match(e.ref, /^[A-Z]+-\d+$/, `ref must be a BACKLOG id: ${e.ref}`);
    }
  });

  it("SELF-CHECK: no entry cites a BACKLOG row that has shipped — the registry cannot rot the way the list it replaces did", () => {
    // Same parse the pm snapshot uses. If a capability listed here ships, its
    // BACKLOG row flips to ✅ and THIS test fails until the entry is removed —
    // the registry is forced to stay current by the same motion that ships.
    const backlog = readFileSync("docs/BACKLOG.md", "utf8").split(/\r?\n/);
    const ITEM = /^\|\s*([A-Z]+-\d+)\s*\|\s*(?:.+?)\s*\|\s*(.*?)\s*\|/;
    const statusById = new Map();
    for (const line of backlog) {
      const m = ITEM.exec(line);
      if (m) statusById.set(m[1], m[2]);
    }
    for (const e of registry) {
      const status = statusById.get(e.ref);
      assert.ok(status, `${e.ref} (cited by "${e.capability.slice(0, 40)}…") is not a BACKLOG row`);
      assert.ok(
        !status.includes("Shipped"),
        `${e.ref} has SHIPPED but the registry still lists "${e.capability.slice(0, 60)}…" as ${e.status} — remove the entry`,
      );
    }
  });

  it("FIXTURE CHECK: the two capabilities the reporter wrongly believed missing are NOT in the registry", () => {
    // capacity>1 and time-bucketed aggregates shipped before the report was
    // filed — the registry must not resurrect them. (This is the negative
    // control: a registry that listed everything would pass the shape test.)
    const flat = JSON.stringify(registry).toLowerCase();
    assert.ok(!flat.includes("capacity"), "capacity: N shipped (bea3377) — must not be listed");
    assert.ok(!/bucket/.test(flat), "date-bucketed aggregates shipped (0ee45c9) — must not be listed");
  });

});

describe("publicRead trap accessNote (21f4c5d5)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("publicread-note");
  });
  after(() => p.destroy());

  it("a gated-read define NAMES the delivery-hidden fields in its own response", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "cases",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "internal_notes", label: "N", type: "text" },
        { name: "assignee", label: "A", type: "text" },
      ],
      access: { read: "authenticated", write: "authenticated", ownerField: "assignee" },
    });
    assert.ok(r.ok, r.errorText);
    assert.ok(r.value.accessNote, "gated read must carry the note");
    assert.match(r.value.accessNote, /authenticated readers too/);
    assert.match(r.value.accessNote, /internal_notes/, "the hidden fields are NAMED — the fix should be one glance");
    assert.match(r.value.accessNote, /serves 1 of 3 fields/);
  });

  it("zero public fields on a gated collection: the note says it is not on delivery AT ALL", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "secrets_log",
      fields: [{ name: "note", label: "N", type: "text" }],
      access: { read: "authenticated", write: "authenticated", ownerField: "note" },
    });
    // ownerField must be text — note qualifies; if this define fails for rule
    // reasons, fall back to a claim rule so the test targets the NOTE, not access.
    const rr = r.ok
      ? r
      : await mcp(p.mcpToken, "define_collection", {
          name: "secrets_log",
          fields: [{ name: "note", label: "N", type: "text" }],
          access: { read: { claim: "role", equals: "staff" } },
        });
    assert.ok(rr.ok, rr.errorText);
    assert.match(rr.value.accessNote, /ZERO delivery-visible fields/);
    assert.match(rr.value.accessNote, /404/);
  });

  it("an ungated collection gets NO note — the note must not become noise", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", publicRead: true },
        { name: "draft_notes", label: "D", type: "text" },
      ],
    });
    assert.ok(r.ok, r.errorText);
    assert.ok(
      !(r.value.accessNote ?? "").includes("authenticated readers"),
      "no read gate → no publicRead note (private fields on a public collection are the normal case)",
    );
  });

  it("the composed-write note and the publicRead note coexist when both apply", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      publicWrite: true,
      fields: [
        { name: "subject", label: "S", type: "text", publicRead: true },
        { name: "triage_notes", label: "T", type: "text" },
      ],
      access: { read: { claim: "role", equals: "staff" }, write: { claim: "role", equals: "staff" } },
    });
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.accessNote, /COMPOSE/, "the pre-existing composed-write note survives");
    assert.match(r.value.accessNote, /triage_notes/, "…and the new note joins it");
  });
});
