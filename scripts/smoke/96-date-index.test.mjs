import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer, createEphemeralProject, mcp, sql, entryIndexNames, collectionId,
} from "./helpers.mjs";

// Burn-down CP4 / field-signal A3 — `indexed` on date fields. Two reporters,
// independently: published_at is THE sort key for content and starts_at/ends_at
// THE scheduling filter, and the old advice ("index another dimension") has no
// substitute for either.
//
// Postgres refuses a ::timestamptz OR ::timestamp expression index (both casts
// are STABLE, verified against PG18), so the index is on RAW TEXT. That is
// exact, not approximate: writes store fixed-width canonical UTC ISO, which
// sorts lexicographically exactly as it sorts chronologically. These tests
// exist to hold that equivalence honest.

describe("A3 — indexed date fields", () => {
  let p, cid;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("date-index");
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "published_at", label: "P", type: "date", indexed: true },
        { name: "plain_at", label: "U", type: "date" }, // unindexed control
      ],
    });
    assert.ok(r.ok, `indexed:true on a date must now be accepted: ${r.errorText}`);
    cid = await collectionId(p.id, "posts");
    // Seed enough rows that the planner picks this index on COST, not because
    // we disabled its alternatives. At three rows every plan is nearly free and
    // a generic collection-index scan plus a sort is perfectly reasonable — so
    // a plan assertion there tests the statistics, not the feature.
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: Array.from({ length: 400 }, (_, i) => ({
        title: `seed ${i}`,
        published_at: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
      })),
    });
    await sql`ANALYZE entries`;
  });
  after(() => p.destroy());

  it("the index actually exists on the tenant table", async () => {
    const names = await entryIndexNames();
    assert.ok(
      names.some((n) => n.includes(cid.replace(/-/g, "")) || n.includes("published_at") || n.includes(cid)),
      `expected a filter index for the collection; saw: ${names.join(", ")}`,
    );
  });

  it("it is a TEXT index — a cast expression would have been refused outright", async () => {
    const [row] = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'entries'
        AND indexdef ILIKE '%published_at%'
        AND indexdef LIKE ${"%" + cid + "%"} LIMIT 1`;
    assert.ok(row, "the index must be present");
    assert.doesNotMatch(row.indexdef, /timestamptz|::timestamp/, "a cast index cannot be created at all");
  });

  it("THE POINT OF THE FEATURE: the planner can actually USE it for range + sort", async () => {
    // Without this, `indexed: true` on a date would be a lie that looks like a
    // feature. A smoke project holds too few rows for the planner to prefer an
    // index on cost, so seqscan is disabled to ask the real question: is this
    // index USABLE for the predicate the query layer emits? (SET LOCAL inside a
    // transaction — neon's HTTP driver gives each query its own session, so a
    // bare SET would silently apply to nothing.)
    //
    // BITMAPSCAN is disabled for the same reason, added 2026-08-04 after this
    // test failed a full verify on a CORRECT platform and then passed standalone
    // on identical code — the definition of a flake. With only seqscan off the
    // planner still had TWO index choices and picked `Bitmap Index Scan` + a
    // separate `Sort`: the index was used perfectly well (range as Index Cond),
    // but the ordered-scan assertions below failed. Plan SHAPE is cost-based, so
    // at fixture scale bitmap+sort legitimately wins while at 100k rows the
    // ordered scan does. Turning both off asks what this test MEANS to ask — can
    // the index serve the range AND the ordering — rather than which plan the
    // planner prefers on 133 rows, which is not a claim the platform makes.
    // Scope to THIS run's collection. Earlier runs leave their own partial
    // indexes behind, so an unordered LIMIT 1 over pg_indexes picks an
    // arbitrary one — possibly for a dropped collection — and the assertion
    // becomes a coin flip.
    const scoped = cid;
    const [row] = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'entries'
        AND indexdef ILIKE '%published_at%'
        AND indexdef LIKE ${"%" + cid + "%"} LIMIT 1`;
    assert.ok(row, `no filter index for collection ${cid}`);
    assert.match(row.indexdef, /collection_id = '/, "the filter index must be partial, scoped to its collection");

    const explain =
      `EXPLAIN SELECT id FROM entries WHERE collection_id='${scoped}' ` +
      `AND (data->>'published_at') > '2026-02-01T00:00:00.000Z' ORDER BY (data->>'published_at')`;
    const res = await sql.transaction([
      sql("SET LOCAL enable_seqscan = off"),
      sql("SET LOCAL enable_bitmapscan = off"),
      sql(explain),
    ]);
    const plan = (res[res.length - 1] ?? []).map((r) => r["QUERY PLAN"]).join("\n");

    assert.match(plan, /Index Scan using entries_fx_/, `expected an index scan, got:\n${plan}`);
    assert.match(plan, /Index Cond:.*published_at/, "the range predicate must be an INDEX COND, not a filter");
    assert.doesNotMatch(plan, /^\s*Sort\b/m, "the index must satisfy ORDER BY too — no separate sort step");
    // The regression this feature actually guards against, asserted directly
    // rather than left to be inferred from the plan shape.
    assert.doesNotMatch(plan, /Seq Scan on entries/, "a sequential scan means the index is unusable, which is the bug");
  });

  it("THE POINT: ordering by an indexed date is chronological, not lexical-by-accident", async () => {
    // Written deliberately out of order, and one of them in a NON-UTC offset —
    // the case that makes naive text comparison wrong if writes were not
    // canonicalized. 09:00+02:00 is 07:00Z, so it must sort FIRST.
    for (const [title, when] of [
      ["third", "2026-03-10T00:00:00Z"],
      ["first", "2026-01-05T09:00:00+02:00"],
      ["second", "2026-02-01T23:30:00Z"],
    ]) {
      const r = await mcp(p.mcpToken, "create_entry", {
        collection: "posts",
        data: { title, published_at: when },
      });
      assert.ok(r.ok, r.errorText);
    }
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      // Restrict to the probe rows: the collection also carries 400 seed rows
      // (there to give the planner a cost-based reason to use the index), and
      // they would otherwise fill the first page.
      where: [{ field: "title", op: "in", value: ["first", "second", "third"] }],
      orderBy: { field: "published_at", dir: "asc" },
    });
    assert.ok(q.ok, q.errorText);
    // The collection also carries seed rows, so assert the RELATIVE order of
    // the three that matter rather than the whole list.
    const order = q.value.entries
      .map((e) => e.data.title)
      .filter((t) => ["first", "second", "third"].includes(t));
    assert.deepEqual(order, ["first", "second", "third"]);
  });

  it("a range filter written in another offset still selects the right rows", async () => {
    // 2026-02-01T00:00:00+00:00 expressed as a +05:00 wall clock.
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [
        { field: "published_at", op: "gt", value: "2026-02-01T05:00:00+05:00" },
        { field: "title", op: "in", value: ["first", "second", "third"] },
      ],
    });
    assert.ok(q.ok, q.errorText);
    const hit = q.value.entries
      .map((e) => e.data.title)
      .filter((t) => ["first", "second", "third"].includes(t))
      .sort();
    assert.deepEqual(hit, ["second", "third"]);
  });

  it("the indexed and UNINDEXED paths agree exactly", async () => {
    // The equivalence claim, tested rather than asserted: the same instants on
    // an unindexed date field must produce the same answer.
    for (const [title, when] of [
      ["u-first", "2026-01-05T09:00:00+02:00"],
      ["u-second", "2026-02-01T23:30:00Z"],
      ["u-third", "2026-03-10T00:00:00Z"],
    ]) {
      await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title, plain_at: when } });
    }
    const indexed = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "published_at", op: "gt", value: "2026-02-01T05:00:00+05:00" }],
    });
    const plain = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "plain_at", op: "gt", value: "2026-02-01T05:00:00+05:00" }],
    });
    assert.equal(
      indexed.value.entries.length,
      plain.value.entries.length,
      "the text path and the timestamptz path must select the same number of rows",
    );
  });

  it("an unparseable filter value ERRORS rather than quietly matching wrong rows", async () => {
    // On the text path a garbage value would not blow up the way ::timestamptz
    // did — it would silently compare as raw text. A confidently wrong result
    // set is worse than a failure.
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "published_at", op: "gt", value: "last tuesday" }],
    });
    assert.equal(q.ok, false);
    assert.match(q.errorText, /not a valid date/);
  });

  it("legacy non-canonical rows are backfilled when the index is added", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "legacy",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "at", label: "A", type: "date" },
      ],
    });
    const c = await mcp(p.mcpToken, "create_entry", { collection: "legacy", data: { title: "old" } });
    const lid = await collectionId(p.id, "legacy");
    // Write a NON-canonical offset straight into the row, as a pre-A5 write or
    // a raw import would have left it.
    await sql`
      UPDATE entries SET data = jsonb_set(data, '{at}', to_jsonb('2026-07-04T10:00:00+02:00'::text))
      WHERE id = ${c.value.id}`;

    // Now index it — the backfill must canonicalize before the text index lands.
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "legacy",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "at", label: "A", type: "date", indexed: true },
      ],
    });
    assert.ok(r.ok, r.errorText);

    const [row] = await sql`SELECT data->>'at' AS at FROM entries WHERE id = ${c.value.id}`;
    assert.equal(row.at, "2026-07-04T08:00:00.000Z", "10:00+02:00 must become 08:00Z, or text ordering lies");
    assert.ok(lid);
  });
});
