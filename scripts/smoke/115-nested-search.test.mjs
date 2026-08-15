import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

const rawSql = neon(process.env.DATABASE_URL);

// DM-5 — text inside an array/group is searchable.
//
// Wall 450c3e16 (EasyFilm): a screenplay app models scenes.paragraphs as
// array{item:group{pid,type,text}} — that array IS the prose — and it could not
// be searched by any route. The reporter quoted all three refusals from our own
// contract; nothing behaved wrongly, the capability was simply absent, and the
// workaround was a denormalised `search_text` sibling duplicating the largest
// content in the product.
//
// The child-collection alternative was pre-empted with our own published
// numbers: delivery mutations are 20/min/IP and autosave is the highest-
// frequency write, so one entry per paragraph spends five of twenty to edit
// five lines. The container is the only model that survives the write budget.
describe("DM-5: nested text is searchable (the reporter's case)", () => {
  let p;
  let collId;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("nested-search");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "scenes",
      fields: [
        { name: "slug", label: "Slug", type: "text", required: true, publicRead: true },
        {
          name: "paragraphs",
          label: "Paragraphs",
          type: "array",
          publicRead: true,
          item: {
            type: "group",
            fields: [
              { name: "pid", label: "PID", type: "text" },
              { name: "type", label: "Type", type: "enum", options: ["action", "dialogue"] },
              { name: "text", label: "Text", type: "text", searchable: true },
            ],
          },
        },
      ],
    });
    assert.ok(def.ok, `nested searchable must now be accepted at define time: ${def.errorText}`);
    const [c] = await rawSql`SELECT id FROM collections WHERE project_id = ${p.id} AND name = 'scenes'`;
    collId = c.id;

    await mcp(p.mcpToken, "create_entry", {
      collection: "scenes",
      data: {
        slug: "cold-open",
        paragraphs: [
          { pid: "p1", type: "action", text: "A lighthouse stands against the gale." },
          { pid: "p2", type: "dialogue", text: "We should have turned back." },
        ],
      },
    });
    await mcp(p.mcpToken, "create_entry", {
      collection: "scenes",
      data: {
        slug: "the-harbour",
        paragraphs: [
          { pid: "p3", type: "action", text: "Nets pile on the wet stone." },
          { pid: "p4", type: "dialogue", text: "Nobody sails tonight." },
        ],
      },
    });
  });
  after(() => p.destroy());

  it("search_entries matches a term inside the repeater", async () => {
    const r = await mcp(p.mcpToken, "search_entries", { collection: "scenes", q: "lighthouse" });
    assert.ok(r.ok, r.errorText);
    const rows = r.value.entries ?? r.value;
    assert.equal(rows.length, 1, "exactly the scene containing that prose");
    assert.equal(rows[0].data.slug, "cold-open");
  });

  it("a hit is the ENTRY, not the element — the whole row comes back intact", async () => {
    // The contract now promises entry granularity. Pin it: the caller gets the
    // full paragraph list, not the matching paragraph.
    const r = await mcp(p.mcpToken, "search_entries", { collection: "scenes", q: "tonight" });
    const rows = r.value.entries ?? r.value;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.slug, "the-harbour");
    assert.equal(rows[0].data.paragraphs.length, 2, "the entry is returned whole");
  });

  it("a sibling sub-field does NOT pollute the index", async () => {
    // THE reason the implementation extracts one named sub-field rather than
    // indexing the container: `type` holds "dialogue" on nearly every scene, so
    // indexing the whole array would make that term match everything.
    const r = await mcp(p.mcpToken, "search_entries", { collection: "scenes", q: "dialogue" });
    assert.ok(r.ok, r.errorText);
    const rows = r.value.entries ?? r.value;
    assert.equal(rows.length, 0, `'dialogue' lives in a sibling sub-field and must not match (got ${rows.length})`);
  });

  it("websearch syntax still applies over nested prose", async () => {
    const phrase = await mcp(p.mcpToken, "search_entries", { collection: "scenes", q: '"wet stone"' });
    assert.equal((phrase.value.entries ?? phrase.value).length, 1, "quoted phrase");
    const excl = await mcp(p.mcpToken, "search_entries", { collection: "scenes", q: "stands -lighthouse" });
    assert.equal((excl.value.entries ?? excl.value).length, 0, "-exclude");
  });

  it("the GIN index extracts the NAMED sub-field via jsonpath", async () => {
    const [row] = await rawSql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'entries' AND indexname LIKE 'entries_fts_%'
        AND indexdef LIKE ${"%" + collId + "%"} LIMIT 1`;
    assert.ok(row, "a public searchable subset must have an index");
    assert.match(row.indexdef, /jsonb_path_query_array/, "nested leaves are extracted, not scanned");
    assert.match(row.indexdef, /paragraphs/, "…from the named container");
    assert.match(row.indexdef, /collection_id = '/, "still a partial index scoped to its collection");
  });
});

// The define-time gate moved for exactly ONE knob. Everything else that does not
// recurse must still refuse, or this change quietly widened more than it claims.
describe("DM-5: the nested gate lifted for `searchable` only", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("nested-gate");
  });
  after(() => p.destroy());

  const def = (sub) =>
    mcp(p.mcpToken, "define_collection", {
      name: "probe",
      dryRun: true,
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "body", label: "B", type: "array", item: { type: "group", fields: [{ name: "x", label: "X", type: "text" }, sub] } },
      ],
    });

  it("searchable on a nested text sub-field is accepted", async () => {
    const r = await def({ name: "prose", label: "P", type: "text", searchable: true });
    assert.ok(r.ok, `expected acceptance, got: ${r.errorText}`);
  });

  it("searchable on a nested richtext sub-field is accepted", async () => {
    const r = await def({ name: "prose", label: "P", type: "richtext", searchable: true });
    assert.ok(r.ok, `expected acceptance, got: ${r.errorText}`);
  });

  it("searchable on a nested NON-text sub-field is refused, naming the type", async () => {
    // A silent no-op would be worse: the caller would believe the number was
    // searchable and get an empty result set forever.
    const r = await def({ name: "count", label: "C", type: "number", searchable: true });
    assert.ok(!r.ok, "a number sub-field has no text to index");
    assert.match(r.errorText, /searchable is only valid on a text\/richtext sub-field/);
    assert.match(r.errorText, /number/, "the refusal names the offending type");
  });

  for (const [knob, sub] of [
    ["unique", { name: "u", label: "U", type: "text", unique: true }],
    ["computed", { name: "c", label: "C", type: "text", computed: { fn: "uuid" } }],
    ["localized", { name: "l", label: "L", type: "text", localized: true }],
    ["requiredIf", { name: "r", label: "R", type: "text", requiredIf: { field: "x", equals: "y" } }],
  ]) {
    it(`${knob} is STILL refused inside a group/array`, async () => {
      const r = await def(sub);
      assert.ok(!r.ok, `${knob} must not have been lifted alongside searchable`);
      assert.match(r.errorText, new RegExp(`${knob} not supported inside a group/array`));
    });
  }

  it("writeOnly is STILL refused inside a group/array, with its own reason", async () => {
    // SEC-1 called this a hard no rather than a "yet", because the nested read
    // gate is public-by-default. Keep the distinct message.
    const r = await def({ name: "w", label: "W", type: "text", writeOnly: true });
    assert.ok(!r.ok);
    assert.match(r.errorText, /writeOnly is only valid on a TOP-LEVEL field/);
  });

  it("indexed is STILL refused on a container", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "probe2",
      dryRun: true,
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "body", label: "B", type: "group", indexed: true, fields: [{ name: "x", label: "X", type: "text" }] },
      ],
    });
    assert.ok(!r.ok);
    assert.match(r.errorText, /indexed is not valid on group\/array/);
  });
});

// Containers other than array-of-group, and richtext's tag stripping.
describe("DM-5: groups, typed blocks, and nested richtext", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("nested-shapes");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "pages",
      fields: [
        { name: "slug", label: "S", type: "text", required: true, publicRead: true },
        {
          name: "seo",
          label: "SEO",
          type: "group",
          publicRead: true,
          fields: [
            { name: "summary", label: "Sum", type: "text", searchable: true },
            { name: "robots", label: "R", type: "text" },
          ],
        },
        {
          name: "sections",
          label: "Sections",
          type: "array",
          publicRead: true,
          blocks: [
            {
              name: "hero",
              label: "Hero",
              fields: [{ name: "heading", label: "H", type: "text", searchable: true }],
            },
            {
              name: "prose",
              label: "Prose",
              fields: [{ name: "body", label: "B", type: "richtext", searchable: true }],
            },
          ],
        },
      ],
    });
    assert.ok(def.ok, def.errorText);
    await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: {
        slug: "landfall",
        seo: { summary: "An oxblood coastline", robots: "noindex" },
        sections: [
          { _type: "hero", heading: "Landfall" },
          { _type: "prose", body: "<p>Storm <em>rising</em> fast</p>" },
        ],
      },
    });
  });
  after(() => p.destroy());

  const hits = async (q) => {
    const r = await mcp(p.mcpToken, "search_entries", { collection: "pages", q });
    assert.ok(r.ok, r.errorText);
    return (r.value.entries ?? r.value).length;
  };

  it("a GROUP sub-field is searchable, and its sibling is not", async () => {
    assert.equal(await hits("oxblood"), 1);
    assert.equal(await hits("noindex"), 0, "`robots` was never marked searchable");
  });

  it("a TYPED BLOCK sub-field is searchable", async () => {
    assert.equal(await hits("landfall"), 1);
  });

  it("nested richtext indexes its prose, not its markup", async () => {
    assert.equal(await hits("rising"), 1, "prose inside a tag is found");
    // NOTE, measured rather than assumed: asserting that "em" and "p" do not
    // match would be VACUOUS. Postgres's default parser classifies an HTML tag
    // as a `tag` token and the config maps it to no dictionary, so tag names are
    // dropped whether or not we strip them. Removing our regexp_replace leaves
    // every such assertion green — which is exactly what the negative control
    // for this test showed, and why it is not asserted here.
    assert.equal(await hits("em"), 0);
  });

  it("nested richtext is treated IDENTICALLY to top-level richtext", async () => {
    // This is the contract's actual claim, and unlike the tag-name assertions
    // above it IS controlled: the two paths build different SQL, so dropping the
    // nested tag handling makes them diverge and fails this test. The fixture
    // uses the one input where stripping is observable at all — a `<`…`>` span
    // in ordinary prose, which the strip treats as a tag.
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "parity",
      fields: [
        { name: "slug", label: "S", type: "text", required: true },
        { name: "top", label: "Top", type: "richtext", searchable: true },
        {
          name: "wrap",
          label: "Wrap",
          type: "group",
          fields: [{ name: "nested", label: "N", type: "richtext", searchable: true }],
        },
      ],
    });
    assert.ok(r.ok, r.errorText);
    const prose = "sounding 5 < 10 and depth > 3 fathoms";
    await mcp(p.mcpToken, "create_entry", { collection: "parity", data: { slug: "a", top: prose } });
    await mcp(p.mcpToken, "create_entry", { collection: "parity", data: { slug: "b", wrap: { nested: prose } } });

    for (const term of ["sounding", "fathoms", "depth", "10"]) {
      const q = await mcp(p.mcpToken, "search_entries", { collection: "parity", q: term });
      assert.ok(q.ok, q.errorText);
      const slugs = (q.value.entries ?? q.value).map((e) => e.data.slug).sort();
      assert.deepEqual(
        slugs,
        slugs.includes("a") ? ["a", "b"] : [],
        `"${term}" must behave the same nested as it does at top level (got ${JSON.stringify(slugs)})`,
      );
    }
  });
});

// The disclosure boundary. Search must never match prose the delivery API
// would not return — otherwise ?q= is an oracle over private content, which is
// the SEC-1 failure class with extra steps.
describe("DM-5: nested search respects the delivery read gate", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("nested-gate-public");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      fields: [
        { name: "slug", label: "S", type: "text", required: true, publicRead: true },
        {
          name: "shown",
          label: "Shown",
          type: "array",
          publicRead: true,
          item: {
            type: "group",
            fields: [
              { name: "text", label: "T", type: "text", searchable: true },
              // Opt-out INSIDE a public container: public by default, so this
              // must be excluded explicitly.
              { name: "internal", label: "I", type: "text", searchable: true, publicRead: false },
            ],
          },
        },
        {
          // Container NOT publicRead → nothing inside it is delivery-readable.
          name: "hidden",
          label: "Hidden",
          type: "array",
          item: { type: "group", fields: [{ name: "text", label: "T", type: "text", searchable: true }] },
        },
      ],
    });
    assert.ok(def.ok, def.errorText);
    await mcp(p.mcpToken, "create_entry", {
      collection: "docs",
      data: {
        slug: "d1",
        shown: [{ text: "publishable prose", internal: "reviewernote" }],
        hidden: [{ text: "embargoed" }],
      },
    });
  });
  after(() => p.destroy());

  const dq = async (q) => {
    const r = await delivery(p.deliveryToken, `/docs?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
    // The delivery envelope is {data:[...]}. Reading a key that does not exist
    // and defaulting to 0 is how an absence test passes vacuously — the first
    // draft of this helper did exactly that, and all three "must NOT match"
    // assertions below went green while the feature was untested.
    assert.ok(Array.isArray(r.json.data), `delivery envelope changed: ${JSON.stringify(r.json).slice(0, 200)}`);
    return r.json.data.length;
  };
  const mq = async (q) => {
    const r = await mcp(p.mcpToken, "search_entries", { collection: "docs", q });
    assert.ok(r.ok, r.errorText);
    return (r.value.entries ?? r.value).length;
  };

  it("delivery ?q= matches a nested field inside a PUBLIC container", async () => {
    assert.equal(await dq("publishable"), 1);
  });

  it("delivery ?q= must NOT match a sub-field with publicRead:false", async () => {
    assert.equal(await dq("reviewernote"), 0, "an opted-out sub-field is not delivery-searchable");
  });

  it("delivery ?q= must NOT match anything inside a NON-public container", async () => {
    assert.equal(await dq("embargoed"), 0, "a private container's prose is not delivery-searchable");
  });

  it("…yet MCP, which is trusted, finds all three", async () => {
    // The positive control for the two absences above: the terms DO exist and
    // ARE indexed, so the zeros are the read gate, not an empty fixture.
    assert.equal(await mq("publishable"), 1);
    assert.equal(await mq("reviewernote"), 1);
    assert.equal(await mq("embargoed"), 1);
  });

  it("the PUBLIC index contains only the public nested path", async () => {
    const [c] = await rawSql`SELECT id FROM collections WHERE project_id = ${p.id} AND name = 'docs'`;
    const [row] = await rawSql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'entries' AND indexname LIKE 'entries_fts_%'
        AND indexdef LIKE ${"%" + c.id + "%"} LIMIT 1`;
    assert.ok(row, "the public subset is non-empty, so an index must exist");
    assert.match(row.indexdef, /shown/, "the public container's path is indexed");
    assert.doesNotMatch(row.indexdef, /hidden/, "a private container must never reach the PUBLIC index");
    assert.doesNotMatch(row.indexdef, /internal/, "…nor an opted-out sub-field");
  });
});

// Two integrity properties of the emitted expression. Both are silent failures
// if broken — nothing errors, searches just stop using the index — which is why
// they are asserted on the index definition rather than on a result set.
describe("DM-5: index/expression integrity", () => {
  let p;
  let collId;
  const idxdef = async () => {
    const [row] = await rawSql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'entries' AND indexname LIKE 'entries_fts_%'
        AND indexdef LIKE ${"%" + collId + "%"} LIMIT 1`;
    return row?.indexdef ?? null;
  };

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("nested-idx");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true, searchable: true },
        {
          name: "body",
          label: "B",
          type: "array",
          publicRead: true,
          item: { type: "group", fields: [{ name: "para", label: "P", type: "text" }] },
        },
      ],
    });
    const [c] = await rawSql`SELECT id FROM collections WHERE project_id = ${p.id} AND name = 'posts'`;
    collId = c.id;
  });
  after(() => p.destroy());

  it("with NO nested searchable field the expression is unchanged from before DM-5", async () => {
    // Not cosmetic. syncSearchIndex rebuilds only when the expression changes,
    // so if DM-5 had altered the emitted SQL for untouched collections, every
    // existing GIN index would have survived while no longer planner-matching —
    // silent sequential scans across the fleet, with nothing failing anywhere.
    const def = await idxdef();
    assert.ok(def, "a top-level searchable public field must still be indexed");
    assert.doesNotMatch(def, /jsonb_path_query_array/, "no nested leaves, so no extraction terms");
    assert.match(
      def,
      /to_tsvector\('simple'::regconfig, COALESCE\(\(data ->> 'title'::text\), ''::text\)\)/,
      "the pre-DM-5 shape, byte for byte",
    );
  });

  it("marking a NESTED sub-field searchable rebuilds the index", async () => {
    // The rebuild used to be keyed on each public searchable field's name:type.
    // A nested toggle changes neither — `body` stays `body:array` — so the
    // subset read as unchanged and the index was never rebuilt. Caught before
    // shipping; this is the regression pin.
    const before = await idxdef();
    assert.doesNotMatch(before, /jsonb_path_query_array/);

    const r = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true, searchable: true },
        {
          name: "body",
          label: "B",
          type: "array",
          publicRead: true,
          item: { type: "group", fields: [{ name: "para", label: "P", type: "text", searchable: true }] },
        },
      ],
    });
    assert.ok(r.ok, r.errorText);

    const after = await idxdef();
    assert.match(after, /jsonb_path_query_array/, "the nested toggle must rebuild the index");
    assert.match(after, /para/, "…over the newly searchable sub-field");
  });

  it("un-marking it rebuilds back, leaving no stale extraction term", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true, searchable: true },
        {
          name: "body",
          label: "B",
          type: "array",
          publicRead: true,
          item: { type: "group", fields: [{ name: "para", label: "P", type: "text" }] },
        },
      ],
      confirm: true,
    });
    assert.ok(r.ok, r.errorText);
    assert.doesNotMatch(await idxdef(), /jsonb_path_query_array/);
  });
});
