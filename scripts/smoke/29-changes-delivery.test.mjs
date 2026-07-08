import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  connectClerk,
  startMockIssuer,
  mcp,
  delivery,
  waitFor,
} from "./helpers.mjs";

// H2: GET /v1/changes with the then-AND-now intersection gate. The core privacy
// properties: only publicRead-both-then-and-now fields project; publicFilter
// exit becomes a tombstone; a never-visible row is suppressed; BROADENING
// visibility never exposes history.
describe("change feed delivery + intersection gate (H2)", () => {
  let p, issuer;

  async function bootstrap(userToken) {
    const r = await delivery(p.deliveryToken, "/changes", { userToken });
    return r.json.cursor;
  }
  async function poll(cursor, pred, userToken) {
    return waitFor(
      async () => {
        const r = await delivery(p.deliveryToken, `/changes?since=${cursor}&limit=500`, { userToken });
        const changes = r.json.changes ?? [];
        return pred(changes) ? changes : null;
      },
      { timeoutMs: 9000, stepMs: 700 },
    );
  }

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("changes-del");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    const d = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "secret", label: "S", type: "text" }, // private
        { name: "published", label: "P", type: "boolean" }, // private; drives publicFilter
      ],
      publicFilter: [{ field: "published", op: "eq", value: true }],
    });
    assert.ok(d.ok, d.errorText);
  });
  after(async () => {
    await issuer.close();
    await p.destroy();
  });

  it("projects only publicRead fields; hidden-by-publicFilter rows never appear", async () => {
    const cur = await bootstrap();
    const a = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "a", secret: "x", published: true } });
    const b = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "b", secret: "y", published: false } });

    const changes = await poll(cur, (cs) => cs.some((c) => c.id === a.value.id));
    const rowA = changes.find((c) => c.id === a.value.id);
    assert.ok(rowA, "visible create surfaces");
    assert.equal(rowA.kind, "created");
    assert.deepEqual(rowA.data, { title: "a" }, "only publicRead fields — no secret, no published");
    assert.ok(!changes.some((c) => c.id === b.value.id), "publicFilter-hidden row never appears");
  });

  it("an update that leaves publicFilter becomes a `deleted` tombstone; hidden-row delete is suppressed", async () => {
    const cur = await bootstrap();
    const a = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "t", published: true } });
    // hide it — visible → hidden ⇒ tombstone
    await mcp(p.mcpToken, "update_entry", { collection: "posts", id: a.value.id, data: { published: false } });
    const changes = await poll(cur, (cs) => cs.some((c) => c.id === a.value.id && c.kind === "deleted"));
    const tomb = changes.find((c) => c.id === a.value.id && c.kind === "deleted");
    assert.ok(tomb, "leaving publicFilter emits a deleted tombstone");
    assert.equal(tomb.data, undefined, "tombstones carry no data");

    // a row hidden its whole life: create hidden, then delete → no tombstone
    const h = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "h", published: false } });
    await mcp(p.mcpToken, "delete_entry", { collection: "posts", id: h.value.id });
    await new Promise((r) => setTimeout(r, 3000)); // past hold-back
    const after = await delivery(p.deliveryToken, `/changes?since=${cur}&limit=500`);
    assert.ok(!after.json.changes.some((c) => c.id === h.value.id), "never-visible row's delete is suppressed");
  });

  it("BROADENING visibility does not expose history: a field flipped public stays hidden on pre-flip rows", async () => {
    const cur = await bootstrap();
    const old = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "old", secret: "PRE", published: true } });
    await poll(cur, (cs) => cs.some((c) => c.id === old.value.id)); // ensure recorded

    // Flip `secret` to publicRead — must NOT retroactively expose the pre-flip row's secret.
    const redef = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "secret", label: "S", type: "text", publicRead: true }, // now public
        { name: "published", label: "P", type: "boolean" },
      ],
      publicFilter: [{ field: "published", op: "eq", value: true }],
    });
    assert.ok(redef.ok, redef.errorText);

    const fresh = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "new", secret: "POST", published: true } });
    await poll(cur, (cs) => cs.some((c) => c.id === fresh.value.id));

    const all = (await delivery(p.deliveryToken, `/changes?since=${cur}&limit=500`)).json.changes;
    const oldRow = all.find((c) => c.id === old.value.id && c.kind === "created");
    const newRow = all.find((c) => c.id === fresh.value.id && c.kind === "created");
    assert.equal(oldRow.data.secret, undefined, "pre-flip row's secret stays hidden (write-time vis wins)");
    assert.equal(newRow.data.secret, "POST", "post-flip row shows the now-public field");
  });

  it("draft→publish (hidden→visible via a private flip) IS emitted, not dropped", async () => {
    const cur = await bootstrap();
    // Create hidden (published:false) — its `created` is suppressed.
    const d = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "draft", published: false } });
    // Publish by flipping ONLY the private `published` field (title unchanged).
    await mcp(p.mcpToken, "update_entry", { collection: "posts", id: d.value.id, data: { published: true } });
    // The row must now appear in the feed (the only event announcing it exists).
    const changes = await poll(cur, (cs) => cs.some((c) => c.id === d.value.id));
    const row = changes.find((c) => c.id === d.value.id);
    assert.ok(row, "the newly-published row must surface (not swallowed by the timing-leak drop)");
    assert.deepEqual(row.data, { title: "draft" }, "carries the public projection so a client can upsert it");
  });

  it("bootstrap returns an empty page at the latest cursor; a bad cursor is 422", async () => {
    const boot = await delivery(p.deliveryToken, "/changes");
    assert.equal(boot.status, 200);
    assert.deepEqual(boot.json.changes, []);
    assert.ok(boot.json.cursor);
    const bad = await delivery(p.deliveryToken, "/changes?since=not-a-cursor");
    assert.equal(bad.status, 422);
    assert.equal(bad.json.code, "E_VALIDATION");
  });

  it("owner identity gate: each owner sees only their own rows in the feed", async () => {
    const od = await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
      ],
      access: { read: "owner", write: "owner", ownerField: "owner" },
    });
    assert.ok(od.ok, od.errorText);
    const alice = await issuer.tokenFor("alice", {});
    const bob = await issuer.tokenFor("bob", {});
    // MCP (trusted) creates rows owned by each.
    const na = await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { body: "alice-note", owner: "alice" } });
    await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { body: "bob-note", owner: "bob" } });

    const cur = await bootstrap(alice);
    // fresh writes after the bootstrap cursor — owner is private, so identity is
    // verified by which entry IDs surface, not by projected data.
    const na2 = await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { body: "alice-2", owner: "alice" } });
    const nb2 = await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { body: "bob-2", owner: "bob" } });

    const aliceChanges = await poll(cur, (cs) => cs.some((c) => c.id === na2.value.id), alice);
    assert.ok(aliceChanges.some((c) => c.id === na2.value.id), "alice sees her own note");
    assert.ok(!aliceChanges.some((c) => c.id === nb2.value.id), "alice does NOT see bob's note");
    void na;

    // an anonymous caller (no user token) sees NO owner-gated rows
    const anon = await delivery(p.deliveryToken, `/changes?since=${cur}&limit=500`);
    assert.ok(!anon.json.changes.some((c) => c.collection === "notes"), "anonymous sees no owner-gated changes");
  });
});
