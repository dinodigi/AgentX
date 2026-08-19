import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { layoutSchemaMap, summarize } from "../../lib/schema-map.ts";

// The schema map lays the content model out as a graph.
//
// Tested at the LAYOUT layer rather than through the rendered page, for two
// reasons. The page is Clerk-gated, so a wire test would be testing auth. And
// more importantly a layout defect is SILENT: a diagram is always *a* diagram,
// so nothing errors when nodes overlap, an edge points at a collection that is
// not drawn, or the public view quietly includes a private field. Those are the
// failures worth pinning, and they are pure functions of the input.
//
// lib/schema-map.ts imports nothing and uses only erasable TypeScript
// specifically so this file can import it directly.

/** The reporter-shaped fixture: our own auth_kit, trimmed to its relations. */
const AUTH_KIT = [
  { name: "permissions", fields: [{ name: "key", type: "text", unique: true }] },
  { name: "roles", fields: [{ name: "name", type: "text", unique: true }, { name: "permissions", type: "array" }] },
  {
    name: "users",
    fields: [
      { name: "email", type: "text", unique: true },
      { name: "role", type: "relation", targetCollection: "roles" },
    ],
  },
  {
    name: "orgs",
    fields: [
      { name: "slug", type: "text", unique: true },
      { name: "owner", type: "relation", targetCollection: "users" },
    ],
  },
  {
    name: "memberships",
    fields: [
      { name: "user", type: "relation", targetCollection: "users" },
      { name: "org", type: "relation", targetCollection: "orgs" },
      { name: "role", type: "relation", targetCollection: "roles" },
    ],
  },
];

describe("schema map: layout", () => {
  it("draws every collection and one edge per relation field", () => {
    const l = layoutSchemaMap(AUTH_KIT);
    assert.equal(l.nodes.length, 5);
    // 1 (users.role) + 1 (orgs.owner) + 3 (memberships) = 5
    assert.equal(l.edges.length, 5);
    const labels = l.edges.map((e) => `${e.from}.${e.field}->${e.to}`).sort();
    assert.deepEqual(labels, [
      "memberships.org->orgs",
      "memberships.role->roles",
      "memberships.user->users",
      "orgs.owner->users",
      "users.role->roles",
    ]);
  });

  it("every edge label is the FIELD that owns it, not the target name", () => {
    // An unlabelled arrow is "related somehow". The field name is the only label
    // that tells a reader which column carries the reference — and `memberships`
    // has three edges, so target names alone would be ambiguous.
    const l = layoutSchemaMap(AUTH_KIT);
    for (const e of l.edges) {
      const src = AUTH_KIT.find((c) => c.name === e.from);
      const f = src.fields.find((x) => x.name === e.field);
      assert.ok(f, `edge label "${e.field}" is not a field on ${e.from}`);
      assert.equal(f.targetCollection, e.to, "the label must name the field that produces this edge");
    }
  });

  it("layers put referrers LEFT of what they reference", () => {
    // The whole point of the layering: every arrow points the same way, so a
    // dependency can be read without tracing.
    const l = layoutSchemaMap(AUTH_KIT);
    const at = new Map(l.nodes.map((n) => [n.name, n]));
    for (const e of l.edges) {
      assert.ok(
        at.get(e.from).x < at.get(e.to).x,
        `${e.from} must sit left of ${e.to} (got ${at.get(e.from).x} vs ${at.get(e.to).x})`,
      );
    }
  });

  it("nodes never overlap", () => {
    // The silent failure this whole file exists for.
    const l = layoutSchemaMap(AUTH_KIT);
    for (let i = 0; i < l.nodes.length; i++) {
      for (let j = i + 1; j < l.nodes.length; j++) {
        const a = l.nodes[i];
        const b = l.nodes[j];
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.name} overlaps ${b.name}`);
      }
    }
  });

  it("every node fits inside the reported viewBox", () => {
    const l = layoutSchemaMap(AUTH_KIT);
    for (const n of l.nodes) {
      assert.ok(n.x >= 0 && n.x + n.w <= l.width, `${n.name} escapes the width (${l.width})`);
      assert.ok(n.y >= 0 && n.y + n.h <= l.height, `${n.name} escapes the height (${l.height})`);
    }
  });

  it("is deterministic — the same input gives byte-identical geometry", () => {
    // Two renders of one schema must not shuffle. Otherwise the map is useless
    // as a reference and every screenshot disagrees with the last.
    const a = JSON.stringify(layoutSchemaMap(AUTH_KIT));
    const shuffled = [...AUTH_KIT].reverse();
    const b = JSON.stringify(layoutSchemaMap(shuffled));
    assert.equal(a, b, "layout must not depend on the order collections arrive in");
  });

  it("terminates on a circular reference, and says so", () => {
    // Two collections may legally point at each other. A naive depth walk
    // recurses forever; the map must still draw and must admit the ambiguity
    // rather than presenting an arbitrary order as fact.
    const cyclic = [
      { name: "a", fields: [{ name: "b_ref", type: "relation", targetCollection: "b" }] },
      { name: "b", fields: [{ name: "a_ref", type: "relation", targetCollection: "a" }] },
    ];
    const l = layoutSchemaMap(cyclic);
    assert.equal(l.nodes.length, 2);
    assert.equal(l.edges.length, 2, "both edges are real and must be drawn");
    assert.ok(l.cycles.length > 0, "the cycle must be reported, not hidden");
  });

  it("a self-reference draws the collection but no arrow to nowhere", () => {
    const selfref = [
      {
        name: "pages",
        fields: [
          { name: "title", type: "text" },
          { name: "parent", type: "relation", targetCollection: "pages" },
        ],
      },
    ];
    const l = layoutSchemaMap(selfref);
    assert.equal(l.nodes.length, 1);
    assert.equal(l.edges.length, 0, "a self-edge has no two endpoints to draw between");
  });

  it("a relation to a collection that does not exist is not drawn", () => {
    // define_collection validates relation targets, so this is a legacy or
    // mid-migration definition. An arrow to nothing is worse than no arrow.
    const dangling = [{ name: "posts", fields: [{ name: "author", type: "relation", targetCollection: "gone" }] }];
    const l = layoutSchemaMap(dangling);
    assert.equal(l.edges.length, 0);
  });

  it("caps the rows a node draws and reports the remainder", () => {
    const wide = [{ name: "big", fields: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, type: "text" })) }];
    const l = layoutSchemaMap(wide);
    const n = l.nodes[0];
    assert.ok(n.rows.length < 30, "a 30-field collection must not grow unboundedly");
    assert.equal(n.rows.length + n.hiddenFields, 30, "nothing may be silently dropped from the count");
  });

  it("no two edge labels collide", () => {
    // Added after LOOKING at a real 17-collection schema: every assertion above
    // passed while two labels sat one pixel apart, which is unreadable. A
    // geometry test cannot be written from imagination — this one came from the
    // preview script, and it is why that script exists.
    // The shape that ACTUALLY collides — taken from a live 20-collection project,
    // not imagined. Two earlier fixtures here passed VACUOUSLY: three separate
    // one-relation collections never collide, and neither does a single
    // collection with six relations to one target (its labels are always ~14
    // apart, above the 12px threshold — I had the arithmetic backwards). Real
    // collisions come from DIFFERENT sources in the same column whose anchors
    // happen to land together, which is why this is a real graph.
    //
    // Field COUNTS matter as much as the relations: node height derives from them
    // and label position derives from node height. `C(name, fillers, ...rels)`
    // keeps each collection's real width so the geometry is identical to live.
    // Verified: 3 collisions without the de-collision pass, 0 with it.
    const C = (name, fillers, ...rels) => ({
      name,
      fields: [
        ...Array.from({ length: fillers }, (_, i) => ({ name: `f${i}`, type: "text" })),
        ...rels.map(([n, t]) => ({ name: n, type: "relation", targetCollection: t })),
      ],
    });
    const dense = [
      C("enrollments", 6, ["user", "users"], ["cohort", "cohorts"]),
      C("notifications", 6, ["user", "users"]),
      C("studio_equipment", 4),
      C("notification_prefs", 5, ["user", "users"]),
      C("courses", 12, ["instructor", "users"]),
      C("messages", 4, ["group", "groups"], ["sender", "users"], ["parent", "messages"]),
      C("submissions", 6, ["user", "users"], ["lesson", "lessons"], ["cohort", "cohorts"]),
      C("studio_bookings", 5, ["equipment", "studio_equipment"]),
      C("lessons", 7, ["cohort", "cohorts"]),
      C("announcements", 6, ["cohort", "cohorts"]),
      C("groups", 5, ["cohort", "cohorts"], ["creator", "users"]),
      C("group_memberships", 3, ["user", "users"], ["group", "groups"]),
      C("roles", 4),
      C("users", 9, ["role", "roles"]),
      C("cohorts", 8, ["course", "courses"]),
    ];
    const l = layoutSchemaMap(dense);
    assert.ok(l.edges.length >= 15, "fixture must reproduce the real converging graph");
    for (let i = 0; i < l.edges.length; i++) {
      for (let j = i + 1; j < l.edges.length; j++) {
        const a = l.edges[i];
        const b = l.edges[j];
        const clash = Math.abs(a.labelX - b.labelX) < 34 && Math.abs(a.labelY - b.labelY) < 12;
        assert.ok(
          !clash,
          `labels "${a.field}" (${a.labelX},${a.labelY}) and "${b.field}" (${b.labelX},${b.labelY}) overlap`,
        );
      }
    }
  });

  it("an empty schema lays out without throwing", () => {
    const l = layoutSchemaMap([]);
    assert.equal(l.nodes.length, 0);
    assert.ok(l.width > 0 && l.height > 0, "the viewBox must stay valid so the SVG renders");
  });
});

describe("schema map: the public-surface view is a security statement", () => {
  const MIXED = [
    {
      name: "posts",
      publicWrite: false,
      fields: [
        { name: "title", type: "text", publicRead: true },
        { name: "internal_notes", type: "text" },
        { name: "author", type: "relation", targetCollection: "authors" },
      ],
    },
    { name: "authors", fields: [{ name: "name", type: "text", publicRead: true }] },
    { name: "audit", fields: [{ name: "detail", type: "text" }] },
    { name: "contact", publicWrite: true, fields: [{ name: "email", type: "text" }] },
  ];

  it("model mode draws everything", () => {
    const l = layoutSchemaMap(MIXED, "model");
    assert.equal(l.nodes.length, 4);
    assert.equal(l.omitted.length, 0);
  });

  it("public mode omits collections with no publicly readable field", () => {
    const l = layoutSchemaMap(MIXED, "public");
    const drawn = l.nodes.map((n) => n.name).sort();
    assert.deepEqual(drawn, ["authors", "posts"]);
    assert.deepEqual(l.omitted, ["audit", "contact"]);
  });

  it("public mode must NOT draw a private field of a drawn collection", () => {
    // The disclosure assertion. If this leaks, the view claims a field is public
    // when the delivery API would never return it — worse than having no view.
    const l = layoutSchemaMap(MIXED, "public");
    const posts = l.nodes.find((n) => n.name === "posts");
    const shown = posts.rows.map((f) => f.name);
    assert.ok(shown.includes("title"), "positive control: the public field IS drawn");
    assert.ok(!shown.includes("internal_notes"), "a private field must not appear in the public view");
    assert.equal(posts.hiddenFields, 0, "…and must not be counted in '+N more' either, which would leak the count");
  });

  it("public mode drops an edge whose target is not publicly readable", () => {
    // posts.author -> authors survives because authors IS public. Make it
    // private and the edge must disappear rather than point at a missing node.
    const privateAuthors = MIXED.map((c) =>
      c.name === "authors" ? { ...c, fields: [{ name: "name", type: "text" }] } : c,
    );
    const l = layoutSchemaMap(privateAuthors, "public");
    assert.deepEqual(l.nodes.map((n) => n.name), ["posts"]);
    assert.equal(l.edges.length, 0, "an edge to an undrawn collection is an arrow to nowhere");
  });

  it("exposure is classified three ways, including anonymous-write intake", () => {
    const l = layoutSchemaMap(MIXED, "model");
    const by = Object.fromEntries(l.nodes.map((n) => [n.name, n.exposure]));
    assert.equal(by.posts, "public");
    assert.equal(by.authors, "public");
    assert.equal(by.audit, "private");
    assert.equal(by.contact, "intake", "publicWrite with no publicRead is a form, not a private table");
  });

  it("the summary line is derived from the layout, never typed", () => {
    const s = summarize(layoutSchemaMap(MIXED, "model"));
    assert.match(s, /4 collections/);
    assert.match(s, /1 relation\b/);
    assert.match(s, /2 publicly readable/);
    assert.match(s, /1 accepting anonymous writes/);
  });
});
