import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, startHookReceiver, mcp, delivery, waitFor } from "./helpers.mjs";

// I3: computed fields — closed vocabulary (slugify | template | now | uuid),
// derived server-side, never client-supplied, frozen on update.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const postFields = [
  { name: "title", label: "T", type: "text", required: true, publicRead: true },
  { name: "body", label: "B", type: "text", publicRead: true }, // plain, non-source
  { name: "slug", label: "Slug", type: "text", unique: true, publicRead: true, computed: { fn: "slugify", from: "title" } },
  { name: "ref", label: "Ref", type: "text", publicRead: true, computed: { fn: "uuid" } },
  { name: "created_at", label: "C", type: "date", publicRead: true, computed: { fn: "now" } },
  { name: "heading", label: "H", type: "text", publicRead: true, computed: { fn: "template", template: "{{title}}!" } },
];

describe("computed fields (I3)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("computed");
    const def = await mcp(p.mcpToken, "define_collection", { name: "posts", fields: postFields, publicWrite: true });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("stamps all four computed fns server-side on create", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Héllo Wörld" } });
    assert.ok(c.ok, c.errorText);
    const g = await mcp(p.mcpToken, "get_entry", { collection: "posts", id: c.value.id });
    assert.equal(g.value.data.slug, "hello-world", "slugify strips diacritics + spaces");
    assert.match(g.value.data.ref, UUID_RE, "uuid");
    assert.ok(!Number.isNaN(Date.parse(g.value.data.created_at)), "now → ISO date");
    assert.equal(g.value.data.heading, "Héllo Wörld!", "template interpolates the sibling");
  });

  it("rejects a client-supplied computed value (422, code computed)", async () => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "X", slug: "hand-picked" } });
    assert.ok(!r.ok && /is computed|derived server-side/.test(r.errorText), r.errorText);
  });

  it("a unique computed slug collision surfaces the existing 'value already exists'", async () => {
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Same Title" } });
    const dup = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Same Title" } });
    assert.ok(!dup.ok && /already exists|unique/.test(dup.errorText), dup.errorText);
  });

  it("delivery POST stamps computed too, and they read back", async () => {
    const res = await delivery(p.deliveryToken, "/posts", { method: "POST", body: { title: "Via Delivery" } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const read = await delivery(p.deliveryToken, `/posts/${res.json.id}`);
    assert.equal(read.json.data.slug, "via-delivery");
    assert.match(read.json.data.ref, UUID_RE);
  });

  it("update: a client can't patch a computed key; slug recomputes on a source change, stable otherwise (I4)", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "First Version", body: "x" } });
    const patchComputed = await mcp(p.mcpToken, "update_entry", { collection: "posts", id: c.value.id, data: { slug: "manual" } });
    assert.ok(!patchComputed.ok && /is computed/.test(patchComputed.errorText), patchComputed.errorText);
    // A SOURCE change recomputes slug + template.
    const u = await mcp(p.mcpToken, "update_entry", { collection: "posts", id: c.value.id, data: { title: "Second Version" } });
    assert.ok(u.ok, u.errorText);
    assert.equal(u.value.data.slug, "second-version", "slug recomputes when its source changes");
    assert.equal(u.value.data.heading, "Second Version!", "template recomputes when a {{source}} changes");
    const refAfterSlugChange = u.value.data.ref;
    // An UNRELATED change leaves computed fields stable (no source touched).
    const u2 = await mcp(p.mcpToken, "update_entry", { collection: "posts", id: c.value.id, data: { body: "y" } });
    assert.ok(u2.ok, u2.errorText);
    assert.equal(u2.value.data.slug, "second-version", "slug stable when no source changes");
    assert.equal(u2.value.data.ref, refAfterSlugChange, "uuid never recomputes");
  });

  it("bulk_create_entries stamps computed per item (distinct uuids)", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [{ title: "Bulk One" }, { title: "Bulk Two" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.ok(r.value.results.every((x) => x.ok), JSON.stringify(r.value));
    const ids = r.value.results.map((x) => x.id);
    const [a, b] = await Promise.all(ids.map((id) => mcp(p.mcpToken, "get_entry", { collection: "posts", id })));
    assert.equal(a.value.data.slug, "bulk-one");
    assert.equal(b.value.data.slug, "bulk-two");
    assert.notEqual(a.value.data.ref, b.value.data.ref, "each item gets its own uuid");
  });

  it("define-time rules: type match, not-required, plain-sibling references, no chains", async () => {
    const def = (fields) => mcp(p.mcpToken, "define_collection", { name: "bad", fields });
    const wrongType = await def([{ name: "n", label: "N", type: "number", computed: { fn: "slugify", from: "n" } }]);
    assert.ok(!wrongType.ok && /slugify is only valid on a text field/.test(wrongType.errorText), wrongType.errorText);

    const req = await def([
      { name: "t", label: "T", type: "text", required: true },
      { name: "s", label: "S", type: "text", required: true, computed: { fn: "slugify", from: "t" } },
    ]);
    assert.ok(!req.ok && /can't be required/.test(req.errorText), req.errorText);

    const dangling = await def([{ name: "s", label: "S", type: "text", computed: { fn: "slugify", from: "nope" } }]);
    assert.ok(!dangling.ok && /not a sibling field/.test(dangling.errorText), dangling.errorText);

    const chain = await def([
      { name: "a", label: "A", type: "text", computed: { fn: "uuid" } },
      { name: "b", label: "B", type: "text", computed: { fn: "slugify", from: "a" } },
    ]);
    assert.ok(!chain.ok && /can't chain/.test(chain.errorText), chain.errorText);
  });

  it("restoring a version of an entry with computed fields succeeds (preserves the old values)", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Version A" } });
    await mcp(p.mcpToken, "update_entry", { collection: "posts", id: c.value.id, data: { title: "Version B" } });
    const vs = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "posts", id: c.value.id });
      return r.ok && r.value.versions.length >= 1 ? r.value : null;
    });
    const orig = vs.versions.find((v) => v.data.title === "Version A");
    assert.ok(orig, "the pre-update snapshot exists");
    const restored = await mcp(p.mcpToken, "restore_entry_version", { collection: "posts", id: c.value.id, versionId: orig.versionId });
    // Before the fix this failed: the snapshot's computed keys hit INPUT-mode rejection.
    assert.ok(restored.ok, restored.errorText);
    assert.equal(restored.value.data.slug, "version-a", "the version's computed value is preserved");
  });

  it("now:'always' restamps on update; now:'create' + update_entry_if never recompute (I4)", async () => {
    const proj = await createEphemeralProject("computed-i4");
    try {
      await mcp(proj.mcpToken, "define_collection", {
        name: "events",
        fields: [
          { name: "name", label: "N", type: "text", required: true, publicRead: true },
          { name: "slug", label: "S", type: "text", publicRead: true, computed: { fn: "slugify", from: "name" } },
          { name: "created_at", label: "C", type: "date", publicRead: true, computed: { fn: "now" } },
          { name: "updated_at", label: "U", type: "date", publicRead: true, computed: { fn: "now", on: "always" } },
        ],
      });
      const c = await mcp(proj.mcpToken, "create_entry", { collection: "events", data: { name: "Launch" } });
      const g0 = (await mcp(proj.mcpToken, "get_entry", { collection: "events", id: c.value.id })).value.data;
      await new Promise((r) => setTimeout(r, 25)); // distinct timestamp
      const u = await mcp(proj.mcpToken, "update_entry", { collection: "events", id: c.value.id, data: { name: "Relaunch" } });
      assert.equal(u.value.data.slug, "relaunch", "slug recomputes on source change");
      assert.equal(u.value.data.created_at, g0.created_at, "now:'create' stays frozen");
      assert.notEqual(u.value.data.updated_at, g0.updated_at, "now:'always' restamps on update");

      // update_entry_if (CAS) does NOT recompute — a source change via CAS leaves slug stale.
      const cas = await mcp(proj.mcpToken, "update_entry_if", {
        collection: "events",
        id: c.value.id,
        if: [{ field: "name", op: "eq", value: "Relaunch" }],
        data: { name: "CasName" },
      });
      assert.ok(cas.ok, cas.errorText);
      const g1 = (await mcp(proj.mcpToken, "get_entry", { collection: "events", id: c.value.id })).value.data;
      assert.equal(g1.name, "CasName");
      assert.equal(g1.slug, "relaunch", "CAS never recomputes computed fields");
    } finally {
      await proj.destroy();
    }
  });

  it("a recomputed value still obeys its own constraints on update (I4)", async () => {
    const proj = await createEphemeralProject("computed-bounds");
    try {
      await mcp(proj.mcpToken, "define_collection", {
        name: "tags",
        fields: [
          { name: "title", label: "T", type: "text", required: true, publicRead: true },
          { name: "slug", label: "S", type: "text", max: 5, publicRead: true, computed: { fn: "slugify", from: "title" } },
        ],
      });
      const c = await mcp(proj.mcpToken, "create_entry", { collection: "tags", data: { title: "Ab" } });
      assert.equal((await mcp(proj.mcpToken, "get_entry", { collection: "tags", id: c.value.id })).value.data.slug, "ab");
      // Updating to a long title would recompute a slug past max(5) — must be rejected.
      const u = await mcp(proj.mcpToken, "update_entry", { collection: "tags", id: c.value.id, data: { title: "Very Long Title" } });
      assert.ok(!u.ok && /slug.*at most 5|at most 5 characters/.test(u.errorText), u.errorText);
    } finally {
      await proj.destroy();
    }
  });

  it("a beforeUpdate transform CANNOT change a computed field (frozen, restored from current)", async () => {
    const rcv = await startHookReceiver();
    const proj = await createEphemeralProject("computed-hook");
    try {
      await mcp(proj.mcpToken, "define_collection", {
        name: "docs",
        fields: [
          { name: "title", label: "T", type: "text", required: true, publicRead: true },
          { name: "slug", label: "S", type: "text", publicRead: true, computed: { fn: "slugify", from: "title" } },
        ],
        hooks: { beforeUpdate: { url: rcv.url, mode: "transform", timeoutMs: 700 } },
      });
      const c = await mcp(proj.mcpToken, "create_entry", { collection: "docs", data: { title: "Original" } });
      assert.equal((await mcp(proj.mcpToken, "get_entry", { collection: "docs", id: c.value.id })).value.data.slug, "original");
      // The transform echoes the full entry but tampers with slug + changes title.
      rcv.transform({ title: "Edited", slug: "attacker-slug" });
      const u = await mcp(proj.mcpToken, "update_entry", { collection: "docs", id: c.value.id, data: { title: "trigger" } });
      assert.ok(u.ok, u.errorText);
      assert.equal(u.value.data.title, "Edited", "transform's non-computed change applies");
      // The attacker's slug is stripped; I4 then recomputes it from the NEW title —
      // never the attacker's value, and never left stale.
      assert.equal(u.value.data.slug, "edited", "slug is derived from the transform's title, not the attacker's value");

      // test_hook's beforeUpdate preview must AGREE with the write path — the
      // echoed computed key must not be reported as invalid (review fix).
      rcv.transform({ title: "Preview", slug: "echoed" });
      const t = await mcp(proj.mcpToken, "test_hook", { collection: "docs", stage: "beforeUpdate", entryId: c.value.id, data: { title: "trigger" } });
      assert.ok(t.ok, t.errorText);
      assert.equal(t.value.verdict, "replaced");
      assert.equal(t.value.validationOfFinalData.ok, true, "dry-run agrees with the write path (computed key not flagged invalid)");
    } finally {
      await rcv.close();
      await proj.destroy();
    }
  });
});
