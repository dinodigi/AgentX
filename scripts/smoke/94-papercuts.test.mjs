import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// Burn-down CP2 — the Track B papercuts. Each was reported from the field, each
// is small, and none needed a design decision. They share a project because
// they share nothing else.

describe("B5 — increment startingFrom makes the FIRST count atomic", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("papercut-b5");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "views", label: "V", type: "number", integer: true, min: 0 },
      ],
    });
  });
  after(() => p.destroy());

  const newPost = async (title) => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title } });
    assert.ok(r.ok, r.errorText);
    return r.value.id;
  };

  it("an unset field still refuses WITHOUT startingFrom — and now names the fix", async () => {
    const id = await newPost("no-seed");
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "posts",
      id,
      increment: { field: "views", by: 1 },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /startingFrom/, "the error must point at the atomic fix");
    // The old advice is still true but racy; the message must say so, or the
    // reader walks straight back into the bug this parameter removes.
    assert.match(r.errorText, /race/i);
  });

  it("startingFrom sets the value on the first increment, with no seed", async () => {
    const id = await newPost("first");
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "posts",
      id,
      increment: { field: "views", by: 1, startingFrom: 0 },
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.data.views, 1, "0 + 1 on a field that never existed");
  });

  it("and is ignored once the field exists — it is a floor, not an assignment", async () => {
    const id = await newPost("existing");
    await mcp(p.mcpToken, "update_entry_if", {
      collection: "posts", id, increment: { field: "views", by: 5, startingFrom: 0 },
    });
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "posts", id, increment: { field: "views", by: 1, startingFrom: 100 },
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.data.views, 6, "5 + 1 — startingFrom must NOT clobber a real value");
  });

  it("THE POINT: concurrent first-increments lose nothing", async () => {
    // This is the bug. The documented workaround was read -> seed with
    // update_entry -> increment; two callers both read "unset", both seed to 0,
    // and one +1 is overwritten. Ten concurrent calls must total exactly 10.
    const id = await newPost("thundering-herd");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        mcp(p.mcpToken, "update_entry_if", {
          collection: "posts",
          id,
          increment: { field: "views", by: 1, startingFrom: 0 },
        }),
      ),
    );
    const failed = results.filter((r) => !r.ok);
    assert.equal(failed.length, 0, `every call must succeed: ${failed.map((f) => f.errorText).join("; ")}`);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "posts", id });
    assert.equal(got.value.data.views, 10, "ten concurrent first-increments = exactly 10, no lost count");
  });

  it("min/max still guard the result, and a bounds failure is not misreported as unset", async () => {
    const id = await newPost("bounded");
    // views has min:0 — a first decrement to -1 must fail as BOUNDS, not as
    // "field is not set", which would send the caller back to seeding.
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "posts",
      id,
      increment: { field: "views", by: -1, startingFrom: 0 },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /min/, "names the real cause");
    assert.doesNotMatch(r.errorText, /is not set/, "must NOT be diagnosed as unset");
  });

  it("startingFrom respects the integer constraint", async () => {
    const id = await newPost("fractional");
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "posts",
      id,
      increment: { field: "views", by: 1, startingFrom: 0.5 },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /whole number/);
  });

  it("works inside transact too — the schema is wired in both places", async () => {
    const id = await newPost("in-a-batch");
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        {
          op: "update_if",
          collection: "posts",
          id,
          increment: { field: "views", by: 3, startingFrom: 0 },
        },
      ],
    });
    assert.ok(r.ok, r.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "posts", id });
    assert.equal(got.value.data.views, 3);
  });
});

describe("B3 — query_entries accepts `id` in where", () => {
  let p, ids;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("papercut-b3");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "T", type: "text", required: true }],
    });
    ids = [];
    for (const t of ["one", "two", "three"]) {
      const r = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: t } });
      ids.push(r.value.id);
    }
  });
  after(() => p.destroy());

  it("eq on id returns exactly that row", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "id", op: "eq", value: ids[1] }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 1);
    assert.equal(r.value.entries[0].data.title, "two");
  });

  it("THE POINT: `in` fetches a known set in ONE call, not N round trips", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "id", op: "in", value: [ids[0], ids[2]] }],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(
      r.value.entries.map((e) => e.data.title).sort(),
      ["one", "three"],
    );
  });

  it("ne on id excludes it", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "id", op: "ne", value: ids[0] }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 2);
  });

  it("`contains` on id is refused — a uuid substring scan is a footgun", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "id", op: "contains", value: ids[0].slice(0, 6) }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /entry id/);
  });

  it("an unknown field now LISTS id as available", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "nope", op: "eq", value: "x" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /valid fields:.*\bid\b/);
  });

  it("a real field named `id` still wins — the virtual one can never shadow data", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "legacy",
      fields: [
        { name: "id", label: "External ID", type: "text" },
        { name: "note", label: "N", type: "text" },
      ],
    });
    await mcp(p.mcpToken, "create_entry", {
      collection: "legacy",
      data: { id: "EXT-42", note: "imported" },
    });
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "legacy",
      where: [{ field: "id", op: "eq", value: "EXT-42" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 1, "must match the DATA field, not the row id");
    assert.equal(r.value.entries[0].data.note, "imported");
  });
});

describe("B1 — bulk_create_entries accepts create_entry's shape", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("papercut-b1");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "T", type: "text", required: true }],
    });
  });
  after(() => p.destroy());

  it("bare objects still work — the documented shape is untouched", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [{ title: "bare one" }, { title: "bare two" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.created, 2);
  });

  it("THE FIX: the create_entry wrapper is unwrapped instead of failing all 14", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [
        { collection: "posts", data: { title: "wrapped one" } },
        { data: { title: "wrapped two" } },
      ],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.created, 2, `both wrapped items must land: ${JSON.stringify(r.value.results)}`);
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "title", op: "eq", value: "wrapped one" }],
    });
    assert.equal(q.value.entries.length, 1, "and the TITLE must be stored, not a nested blob");
  });

  it("a mixed batch works — shapes are decided per item", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [{ title: "mixed bare" }, { data: { title: "mixed wrapped" } }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.created, 2);
  });

  it("a collection with its OWN `data` field is never unwrapped", async () => {
    // The ambiguity guard. If we unwrapped here we would silently discard the
    // caller's real payload — far worse than the error we are removing.
    await mcp(p.mcpToken, "define_collection", {
      name: "records",
      fields: [
        { name: "data", label: "Payload", type: "text", required: true },
        { name: "note", label: "N", type: "text" },
      ],
    });
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "records",
      entries: [{ data: "literally the value", note: "keep me" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.created, 1);
    const q = await mcp(p.mcpToken, "query_entries", { collection: "records" });
    assert.equal(q.value.entries[0].data.data, "literally the value");
    assert.equal(q.value.entries[0].data.note, "keep me");
  });
});

describe("B2 — typed-block sub-fields accept explicit null as absent", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("papercut-b2");
    await mcp(p.mcpToken, "define_collection", {
      name: "pages",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        {
          name: "sections",
          label: "Sections",
          type: "array",
          blocks: [
            {
              name: "hero",
              label: "Hero",
              fields: [
                { name: "heading", label: "H", type: "text", required: true },
                { name: "image", label: "Image", type: "asset" },
                { name: "subtitle", label: "Sub", type: "text" },
              ],
            },
          ],
        },
        {
          name: "meta",
          label: "Meta",
          type: "group",
          fields: [
            { name: "author", label: "A", type: "text" },
            { name: "cover", label: "C", type: "asset" },
          ],
        },
      ],
    });
  });
  after(() => p.destroy());

  it("THE FIX: an optional asset sub-field accepts null (an editor's 'nothing selected')", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: {
        title: "null-tolerant",
        sections: [{ _type: "hero", heading: "Welcome", image: null, subtitle: null }],
      },
    });
    assert.ok(r.ok, `null must normalise to absent, not error: ${r.errorText}`);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "pages", id: r.value.id });
    const hero = got.value.data.sections[0];
    assert.equal(hero.heading, "Welcome");
    assert.ok(!("image" in hero) || hero.image == null, "null must not be stored as a value");
  });

  it("the same rule applies inside a group", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { title: "grouped", meta: { author: "me", cover: null } },
    });
    assert.ok(r.ok, r.errorText);
  });

  it("a REQUIRED sub-field still rejects null — that is a real error", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { title: "bad", sections: [{ _type: "hero", heading: null }] },
    });
    assert.equal(r.ok, false, "a required sub-field must not silently vanish");
  });

  it("a real value still round-trips unchanged", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { title: "full", sections: [{ _type: "hero", heading: "H", subtitle: "S" }] },
    });
    assert.ok(r.ok, r.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "pages", id: r.value.id });
    assert.equal(got.value.data.sections[0].subtitle, "S");
  });
});

// The reporter's case was compliance filtering — "exclude opted-out leads" —
// where `ne true` silently drops every lead who never set the flag. That is a
// wrong answer that looks like a working query, so it earned code rather than
// a docs callout it would be easy to skim past.
describe("neOrUnset — the exclusion op", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("papercut-ne");
    await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [
        { name: "email", label: "E", type: "text", required: true },
        { name: "opted_out", label: "O", type: "boolean" },
      ],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "leads",
      entries: [
        { email: "never-set@x.com" }, // the flag was never written
        { email: "opted-in@x.com", opted_out: false },
        { email: "opted-out@x.com", opted_out: true },
      ],
    });
  });
  after(() => p.destroy());

  it("`ne` still excludes unset rows — the fail-closed semantic is unchanged", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ field: "opted_out", op: "ne", value: true }],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.entries.map((e) => e.data.email), ["opted-in@x.com"]);
  });

  it("THE FIX: neOrUnset keeps the rows that never set the flag", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ field: "opted_out", op: "neOrUnset", value: true }],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(
      r.value.entries.map((e) => e.data.email).sort(),
      ["never-set@x.com", "opted-in@x.com"],
      "the mailable set — everyone who has not opted out",
    );
  });

  it("it agrees with the old anyOf idiom exactly", async () => {
    const idiom = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ anyOf: [{ field: "opted_out", op: "ne", value: true }, { field: "opted_out", op: "exists", value: false }] }],
    });
    const op = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ field: "opted_out", op: "neOrUnset", value: true }],
    });
    assert.deepEqual(
      op.value.entries.map((e) => e.data.email).sort(),
      idiom.value.entries.map((e) => e.data.email).sort(),
    );
  });

  it("SQL and the in-memory matcher agree — or gates would diverge from lists", async () => {
    // update_entry_if compiles the SAME clause through the JS matcher path.
    // A divergence here matches in list queries but fails single-entry gates.
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ field: "opted_out", op: "eq", value: true }],
    });
    const optedOutId = q.value.entries[0].id;
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "leads",
      id: optedOutId,
      if: [{ field: "opted_out", op: "neOrUnset", value: true }],
      data: { email: "should-not-apply@x.com" },
    });
    assert.equal(r.ok, false, "an opted-out row must NOT satisfy neOrUnset true");
  });

  it("works on text fields too", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ field: "email", op: "neOrUnset", value: "opted-out@x.com" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 2);
  });
});
