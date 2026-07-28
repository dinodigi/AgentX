import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql } from "./helpers.mjs";

// Burn-down CP6 — schema mutation ergonomics.

describe("addFields — append without re-sending the whole shape", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("addfields");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "body", label: "B", type: "richtext" },
      ],
    });
  });
  after(() => p.destroy());

  it("appends and leaves everything else untouched", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      addFields: [{ name: "slug", label: "S", type: "text" }],
    });
    assert.ok(r.ok, r.errorText);
    const d = await mcp(p.mcpToken, "describe_collection", { name: "posts" });
    assert.deepEqual(d.value.fields.map((f) => f.name), ["title", "body", "slug"]);
    // The pre-existing constraint must survive — a whole-shape resend that
    // forgot `required` would silently relax it.
    assert.equal(d.value.fields.find((f) => f.name === "title").required, true);
  });

  it("THE POINT: concurrent adders do not lose each other's field", async () => {
    // The hazard `addFields` removes. With the declarative path both agents
    // read the same field list, each appends its own, and the second write
    // erases the first — a lost update that looks like it worked.
    await mcp(p.mcpToken, "define_collection", {
      name: "racey",
      fields: [{ name: "base", label: "B", type: "text", required: true }],
    });
    const [a, b] = await Promise.all([
      mcp(p.mcpToken, "define_collection", {
        name: "racey", addFields: [{ name: "from_a", label: "A", type: "text" }],
      }),
      mcp(p.mcpToken, "define_collection", {
        name: "racey", addFields: [{ name: "from_b", label: "B2", type: "text" }],
      }),
    ]);
    assert.ok(a.ok || b.ok, `at least one must land: ${a.errorText} / ${b.errorText}`);
    const d = await mcp(p.mcpToken, "describe_collection", { name: "racey" });
    const names = d.value.fields.map((f) => f.name);
    // Whichever ordering the two writes took, a SUCCESSFUL add must be present.
    if (a.ok) assert.ok(names.includes("from_a"), `a reported success but from_a is missing: ${names}`);
    if (b.ok) assert.ok(names.includes("from_b"), `b reported success but from_b is missing: ${names}`);
  });

  it("a duplicate name is refused — addFields only appends", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      addFields: [{ name: "title", label: "Dup", type: "text" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /already exists/);
  });

  it("both fields and addFields together is refused, not silently merged", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "T", type: "text", required: true }],
      addFields: [{ name: "extra", label: "E", type: "text" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not both/);
  });

  it("addFields on a collection that does not exist says so", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "nope",
      addFields: [{ name: "x", label: "X", type: "text" }],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /no collection/);
  });

  it("the declarative path is unchanged — omitted fields still DROP", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "declarative",
      fields: [
        { name: "keep", label: "K", type: "text", required: true },
        { name: "drop_me", label: "D", type: "text" },
      ],
    });
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "declarative",
      fields: [{ name: "keep", label: "K", type: "text", required: true }],
      confirm: true,
    });
    assert.ok(r.ok, r.errorText);
    const d = await mcp(p.mcpToken, "describe_collection", { name: "declarative" });
    assert.deepEqual(d.value.fields.map((f) => f.name), ["keep"], "fields must stay whole-shape");
  });
});

describe("bulk_create_entries cap — 100 was the hook budget, not the DB's", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("bulk-cap");
    await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      fields: [
        { name: "email", label: "E", type: "text", required: true },
        { name: "source", label: "S", type: "text" },
      ],
    });
  });
  after(() => p.destroy());

  it("THE POINT: 500 rows land in ONE call", async () => {
    // A reporter measured a 3.1k-lead Salesforce import as ~31 calls. This is
    // the number that turns it into 7 — and it is asserted end-to-end rather
    // than assumed, because a cap nobody exercises is a cap nobody trusts.
    const entries = Array.from({ length: 500 }, (_, i) => ({
      email: `lead${i}@example.com`,
      source: "salesforce",
    }));
    const r = await mcp(p.mcpToken, "bulk_create_entries", { collection: "leads", entries });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.created, 500, `all 500 must insert: ${r.value.failed} failed`);

    const [row] = await sql`
      SELECT count(*)::int AS n FROM entries e
      JOIN collections c ON c.id = e.collection_id
      WHERE c.project_id = ${p.id} AND c.name = 'leads'`;
    assert.equal(row.n, 500, "and actually be in the table");
  });

  it("over the cap is refused with the real number", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({ email: `x${i}@example.com` }));
    const r = await mcp(p.mcpToken, "bulk_create_entries", { collection: "leads", entries });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /500/);
  });
});

describe("enum option renames — the migration that did not exist", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("enum-rename");
    await mcp(p.mcpToken, "define_collection", {
      name: "deals",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "stage", label: "S", type: "enum", options: ["lead", "qualified", "won"] },
      ],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "deals",
      entries: [
        { title: "a", stage: "lead" },
        { title: "b", stage: "lead" },
        { title: "c", stage: "won" },
      ],
    });
  });
  after(() => p.destroy());

  const redefine = (options, renames, confirm) =>
    mcp(p.mcpToken, "define_collection", {
      name: "deals",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "stage", label: "S", type: "enum", options },
      ],
      ...(renames ? { renames } : {}),
      ...(confirm ? { confirm: true } : {}),
    });

  it("THE FIX: an option rename migrates the rows holding the old value", async () => {
    const r = await redefine(
      ["prospect", "qualified", "won"],
      [{ field: "stage", from: "lead", to: "prospect" }],
    );
    assert.ok(r.ok, r.errorText);
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "deals",
      where: [{ field: "stage", op: "eq", value: "prospect" }],
    });
    assert.equal(q.value.entries.length, 2, "both 'lead' rows must now read 'prospect'");
    // ...and the migrated rows are VALID — the orphaning symptom was that they
    // failed validation on their next save.
    const one = q.value.entries[0];
    const upd = await mcp(p.mcpToken, "update_entry", {
      collection: "deals", id: one.id, data: { title: "a2" },
    });
    assert.ok(upd.ok, `a migrated row must still save: ${upd.errorText}`);
  });

  it("untouched options are left alone", async () => {
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "deals",
      where: [{ field: "stage", op: "eq", value: "won" }],
    });
    assert.equal(q.value.entries.length, 1);
  });

  it("renaming to an option that is not in the new definition is refused", async () => {
    const r = await redefine(
      ["prospect", "qualified", "won"],
      [{ field: "stage", from: "prospect", to: "nonexistent" }],
    );
    assert.equal(r.ok, false);
    assert.match(r.errorText, /must be an option/);
  });

  it("renaming FROM a non-option is refused — a typo must not rewrite values", async () => {
    const r = await redefine(
      ["prospect", "qualified", "won", "lost"],
      [{ field: "stage", from: "nope", to: "lost" }],
    );
    assert.equal(r.ok, false);
    assert.match(r.errorText, /not a current option/);
  });

  it("keeping the old option alongside the new one is refused as ambiguous", async () => {
    const r = await redefine(
      ["prospect", "qualified", "won", "closed"],
      [{ field: "stage", from: "prospect", to: "closed" }],
    );
    assert.equal(r.ok, false);
    assert.match(r.errorText, /still an option/);
  });

  it("an option rename is not mistaken for a field rename", async () => {
    // The diff must still see `stage` as an unchanged field, not a drop+add —
    // otherwise the destructive-change gate would fire on a safe migration.
    const r = await redefine(
      ["prospect", "qualified", "closed"],
      [{ field: "stage", from: "won", to: "closed" }],
    );
    assert.ok(r.ok, `an option rename must not read as destructive: ${r.errorText}`);
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "deals",
      where: [{ field: "stage", op: "eq", value: "closed" }],
    });
    assert.equal(q.value.entries.length, 1);
  });

  it("field renames still work — the two forms coexist", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "cards",
      fields: [{ name: "old_name", label: "O", type: "text", required: true }],
    });
    await mcp(p.mcpToken, "create_entry", { collection: "cards", data: { old_name: "kept" } });
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "cards",
      fields: [{ name: "new_name", label: "N", type: "text", required: true }],
      renames: [{ from: "old_name", to: "new_name" }],
    });
    assert.ok(r.ok, r.errorText);
    const q = await mcp(p.mcpToken, "query_entries", { collection: "cards" });
    assert.equal(q.value.entries[0].data.new_name, "kept");
  });
});
