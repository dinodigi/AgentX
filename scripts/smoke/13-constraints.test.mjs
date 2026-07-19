import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  mcp,
  delivery,
  startMockIssuer,
  connectClerk,
} from "./helpers.mjs";

describe("field constraints: unique, min/max, requiredIf", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("constraints");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "products",
      fields: [
        { name: "slug", label: "Slug", type: "text", required: true, unique: true },
        { name: "title", label: "Title", type: "text", min: 3 },
        { name: "price", label: "Price", type: "number", min: 0, max: 1000 },
        { name: "status", label: "Status", type: "enum", options: ["draft", "rejected"] },
        { name: "reason", label: "Reason", type: "text", requiredIf: { field: "status", equals: "rejected" } },
      ],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("unique: duplicate values rejected on create, update, and bulk", async () => {
    const first = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "alpha" },
    });
    assert.ok(first.ok, first.errorText);

    const dup = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "alpha" },
    });
    assert.ok(!dup.ok && /slug: value already exists/.test(dup.errorText), dup.errorText);

    const second = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "beta" },
    });
    assert.ok(second.ok, second.errorText);
    const patchDup = await mcp(p.mcpToken, "update_entry", {
      collection: "products",
      id: second.value.id,
      data: { slug: "alpha" },
    });
    assert.ok(!patchDup.ok && /unique/.test(patchDup.errorText), patchDup.errorText);

    const bulk = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "products",
      entries: [{ slug: "gamma" }, { slug: "alpha" }],
    });
    assert.ok(!bulk.ok && /slug: value already exists/.test(bulk.errorText), bulk.errorText);
  });

  it("min/max: number value bounds and text length bounds", async () => {
    const low = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "p1", price: -5 },
    });
    assert.ok(!low.ok && /price: must be >= 0/.test(low.errorText), low.errorText);

    const high = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "p2", price: 2000 },
    });
    assert.ok(!high.ok && /price: must be <= 1000/.test(high.errorText), high.errorText);

    const short = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "p3", title: "ab" },
    });
    assert.ok(!short.ok && /title: must be at least 3 characters/.test(short.errorText), short.errorText);

    const ok = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "p4", title: "abc", price: 500 },
    });
    assert.ok(ok.ok, ok.errorText);
  });

  it("requiredIf: enforced only when the enum matches", async () => {
    const missing = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "r1", status: "rejected" },
    });
    assert.ok(!missing.ok && /reason: required when status = "rejected"/.test(missing.errorText), missing.errorText);

    const withReason = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "r2", status: "rejected", reason: "broken" },
    });
    assert.ok(withReason.ok, withReason.errorText);

    const draft = await mcp(p.mcpToken, "create_entry", {
      collection: "products",
      data: { slug: "r3", status: "draft" },
    });
    assert.ok(draft.ok, draft.errorText);
  });

  it("meta-validation rejects misplaced constraints", async () => {
    const uniqueBool = await mcp(p.mcpToken, "define_collection", {
      name: "bad1",
      fields: [{ name: "on", label: "On", type: "boolean", unique: true }],
    });
    assert.ok(!uniqueBool.ok && /unique is only valid/.test(uniqueBool.errorText), uniqueBool.errorText);

    // date fields accept ISO-string bounds (A3) — numeric bounds stay rejected
    const minDate = await mcp(p.mcpToken, "define_collection", {
      name: "bad2",
      fields: [{ name: "when", label: "When", type: "date", min: 1 }],
    });
    assert.ok(!minDate.ok && /date min must be a parseable ISO date string/.test(minDate.errorText), minDate.errorText);
    const minBool = await mcp(p.mcpToken, "define_collection", {
      name: "bad2b",
      fields: [{ name: "on", label: "On", type: "boolean", min: 1 }],
    });
    assert.ok(!minBool.ok && /min\/max are only valid/.test(minBool.errorText), minBool.errorText);

    const badRef = await mcp(p.mcpToken, "define_collection", {
      name: "bad3",
      fields: [
        { name: "a", label: "A", type: "text", requiredIf: { field: "b", equals: "x" } },
        { name: "b", label: "B", type: "text" },
      ],
    });
    assert.ok(!badRef.ok && /sibling enum field/.test(badRef.errorText), badRef.errorText);

    const inverted = await mcp(p.mcpToken, "define_collection", {
      name: "bad4",
      fields: [{ name: "n", label: "N", type: "number", min: 10, max: 1 }],
    });
    assert.ok(!inverted.ok && /min must be <= max/.test(inverted.errorText), inverted.errorText);
  });

  it("enabling unique on existing duplicates fails; disabling re-allows them", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text" }],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "tags",
      entries: [{ name: "dup" }, { name: "dup" }],
    });

    const enable = await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text", unique: true }],
    });
    assert.ok(!enable.ok && /duplicate values/.test(enable.errorText), enable.errorText);

    // Dedupe, enable, verify enforcement, then disable and re-allow.
    const rows = await mcp(p.mcpToken, "query_entries", {
      collection: "tags",
      where: [{ field: "name", op: "eq", value: "dup" }],
    });
    await mcp(p.mcpToken, "delete_entry", { collection: "tags", id: rows.value.entries[0].id });

    const enable2 = await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text", unique: true }],
    });
    assert.ok(enable2.ok, enable2.errorText);
    const blocked = await mcp(p.mcpToken, "create_entry", { collection: "tags", data: { name: "dup" } });
    assert.ok(!blocked.ok && /unique/.test(blocked.errorText), blocked.errorText);

    const disable = await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text" }],
    });
    assert.ok(disable.ok, disable.errorText);
    const allowed = await mcp(p.mcpToken, "create_entry", { collection: "tags", data: { name: "dup" } });
    assert.ok(allowed.ok, allowed.errorText);
  });
});

describe("pattern constraint (A1)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("pattern");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "handles",
      publicWrite: true,
      fields: [
        {
          name: "handle",
          label: "Handle",
          type: "text",
          required: true,
          max: 30,
          pattern: "^@[a-z0-9_]{2,29}$",
          patternHint: "handle must be @ followed by 2-29 lowercase letters, digits or _",
        },
      ],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("create/update/bulk violations carry the patternHint verbatim", async () => {
    const bad = await mcp(p.mcpToken, "create_entry", {
      collection: "handles",
      data: { handle: "bad handle" },
    });
    assert.ok(!bad.ok && /handle: handle must be @ followed by 2-29/.test(bad.errorText), bad.errorText);

    const good = await mcp(p.mcpToken, "create_entry", {
      collection: "handles",
      data: { handle: "@alpha_1" },
    });
    assert.ok(good.ok, good.errorText);

    const patch = await mcp(p.mcpToken, "update_entry", {
      collection: "handles",
      id: good.value.id,
      data: { handle: "NOPE" },
    });
    assert.ok(!patch.ok && /handle must be @ followed/.test(patch.errorText), patch.errorText);

    // bulk: validation failures are per-item results, not a batch failure
    const bulk = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "handles",
      entries: [{ handle: "@ok_2" }, { handle: "!bad" }],
    });
    assert.ok(bulk.ok, bulk.errorText);
    const items = bulk.value.results;
    assert.ok(items[0].ok, JSON.stringify(items[0]));
    assert.ok(!items[1].ok && /handle must be @ followed/.test(items[1].error), JSON.stringify(items[1]));
  });

  it("values past max never reach the regex but still fail on length", async () => {
    const long = await mcp(p.mcpToken, "create_entry", {
      collection: "handles",
      data: { handle: "@" + "a".repeat(100) },
    });
    assert.ok(!long.ok && /must be at most 30 characters/.test(long.errorText), long.errorText);
    // length message, not the pattern hint — the regex was skipped
    assert.ok(!/must be @ followed/.test(long.errorText), long.errorText);
  });

  it("delivery POST 422s with the same hint", async () => {
    const bad = await delivery(p.deliveryToken, "/handles", {
      method: "POST",
      body: { handle: "invalid!" },
    });
    assert.equal(bad.status, 422);
    assert.ok(/handle must be @ followed/.test(bad.json.error), bad.json.error);

    const good = await delivery(p.deliveryToken, "/handles", {
      method: "POST",
      body: { handle: "@from_form" },
    });
    assert.equal(good.status, 201);
  });

  it("meta-validation: bad regex, missing/oversized max, misplaced knobs", async () => {
    const badRegex = await mcp(p.mcpToken, "define_collection", {
      name: "bad_re",
      fields: [{ name: "x", label: "X", type: "text", max: 10, pattern: "(" }],
    });
    assert.ok(!badRegex.ok && /not a valid JS regular expression/.test(badRegex.errorText), badRegex.errorText);

    const noMax = await mcp(p.mcpToken, "define_collection", {
      name: "bad_nomax",
      fields: [{ name: "x", label: "X", type: "text", pattern: "^a+$" }],
    });
    assert.ok(!noMax.ok && /pattern requires a max length/.test(noMax.errorText), noMax.errorText);

    const bigMax = await mcp(p.mcpToken, "define_collection", {
      name: "bad_bigmax",
      fields: [{ name: "x", label: "X", type: "text", max: 20000, pattern: "^a+$" }],
    });
    assert.ok(!bigMax.ok && /max must be <= 10000/.test(bigMax.errorText), bigMax.errorText);

    const onNumber = await mcp(p.mcpToken, "define_collection", {
      name: "bad_num",
      fields: [{ name: "x", label: "X", type: "number", pattern: "^a$" }],
    });
    assert.ok(!onNumber.ok && /pattern is only valid on text fields/.test(onNumber.errorText), onNumber.errorText);

    const hintAlone = await mcp(p.mcpToken, "define_collection", {
      name: "bad_hint",
      fields: [{ name: "x", label: "X", type: "text", patternHint: "nope" }],
    });
    assert.ok(!hintAlone.ok && /patternHint is only valid alongside pattern/.test(hintAlone.errorText), hintAlone.errorText);
  });
});

describe("structured ConstraintIssue[] (A2)", () => {
  let p;
  const issuesOf = (errorText) => {
    const line = errorText.split("\nissues: ")[1];
    return line ? JSON.parse(line) : null;
  };
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("issues");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "orders",
      publicWrite: true,
      fields: [
        { name: "sku", label: "SKU", type: "text", required: true, unique: true, max: 20,
          pattern: "^[A-Z]{3}-\\d+$", patternHint: "SKU is 3 capitals, a dash, then digits" },
        { name: "qty", label: "Qty", type: "number", min: 1, max: 99 },
        { name: "state", label: "State", type: "enum", options: ["open", "shipped"] },
      ],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("MCP multi-violation create carries one issue per violation, machine-readable", async () => {
    const bad = await mcp(p.mcpToken, "create_entry", {
      collection: "orders",
      data: { qty: 0, state: "lost", bogus: true },
    });
    assert.ok(!bad.ok, "expected failure");
    assert.ok(/^Error \[E_VALIDATION\]:/.test(bad.errorText), bad.errorText);
    const issues = issuesOf(bad.errorText);
    assert.ok(Array.isArray(issues), "issues block missing: " + bad.errorText);
    const byField = Object.fromEntries(issues.map((i) => [i.field, i]));
    assert.equal(byField.sku.constraint, "required");
    assert.equal(byField.qty.constraint, "min");
    assert.equal(byField.qty.limit, 1);
    assert.equal(byField.state.constraint, "enum");
    assert.deepEqual(byField.state.allowed, ["open", "shipped"]);
    assert.equal(byField.bogus.constraint, "unknown_field");
    for (const i of issues) assert.ok(typeof i.hint === "string" && i.hint.length > 0);
  });

  it("pattern + unique + ref_missing issues carry their extras", async () => {
    const badPattern = await mcp(p.mcpToken, "create_entry", {
      collection: "orders",
      data: { sku: "abc-1" },
    });
    const pi = issuesOf(badPattern.errorText);
    assert.equal(pi[0].constraint, "pattern");
    assert.equal(pi[0].pattern, "^[A-Z]{3}-\\d+$");
    assert.equal(pi[0].hint, "SKU is 3 capitals, a dash, then digits");

    const first = await mcp(p.mcpToken, "create_entry", {
      collection: "orders", data: { sku: "ABC-1" },
    });
    assert.ok(first.ok, first.errorText);
    const dup = await mcp(p.mcpToken, "create_entry", {
      collection: "orders", data: { sku: "ABC-1" },
    });
    const ui = issuesOf(dup.errorText);
    assert.equal(ui[0].constraint, "unique");
    assert.equal(ui[0].field, "sku");

    await mcp(p.mcpToken, "define_collection", {
      name: "lines",
      fields: [{ name: "order", label: "Order", type: "relation", targetCollection: "orders", labelField: "sku" }],
    });
    const badRef = await mcp(p.mcpToken, "create_entry", {
      collection: "lines",
      data: { order: "00000000-0000-4000-8000-000000000000" },
    });
    const ri = issuesOf(badRef.errorText);
    assert.equal(ri[0].constraint, "ref_missing");
    assert.equal(ri[0].field, "order");
  });

  it("delivery 422 envelope carries the same issues array", async () => {
    const bad = await delivery(p.deliveryToken, "/orders", {
      method: "POST",
      body: { qty: 500, state: "lost" },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.code, "E_VALIDATION");
    assert.ok(Array.isArray(bad.json.issues), JSON.stringify(bad.json));
    const byField = Object.fromEntries(bad.json.issues.map((i) => [i.field, i]));
    assert.equal(byField.sku.constraint, "required");
    assert.equal(byField.qty.constraint, "max");
    assert.equal(byField.qty.limit, 99);
    assert.equal(byField.state.constraint, "enum");
  });

  it("requiredIf violations are tagged required_if", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "kind", label: "Kind", type: "enum", options: ["bug", "other"] },
        { name: "details", label: "Details", type: "text", requiredIf: { field: "kind", equals: "other" } },
      ],
    });
    assert.ok(def.ok, def.errorText);
    const bad = await mcp(p.mcpToken, "create_entry", {
      collection: "tickets",
      data: { kind: "other" },
    });
    const issues = issuesOf(bad.errorText);
    assert.equal(issues[0].field, "details");
    assert.equal(issues[0].constraint, "required_if");
  });
});

describe("date bounds + integer (A3), unique dates + instant equality (A5)", () => {
  let p;
  const issuesOf = (errorText) => {
    const line = errorText.split("\nissues: ")[1];
    return line ? JSON.parse(line) : null;
  };
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("dates");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "slots",
      fields: [
        { name: "when", label: "When", type: "date", required: true, unique: true, publicRead: true,
          min: "2026-01-01T00:00:00Z", max: "2026-12-31T23:59:59Z" },
        { name: "seats", label: "Seats", type: "number", integer: true, min: 0, publicRead: true },
      ],
      publicFilter: [{ field: "when", op: "eq", value: "2026-07-04T10:00:00+02:00" }],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("date min/max bounds enforced as instants, with structured min/max issues", async () => {
    const early = await mcp(p.mcpToken, "create_entry", {
      collection: "slots",
      data: { when: "2025-06-01T00:00:00Z" },
    });
    assert.ok(!early.ok && /must be on or after 2026-01-01/.test(early.errorText), early.errorText);
    const issues = issuesOf(early.errorText);
    assert.equal(issues[0].constraint, "min");
    assert.equal(issues[0].limit, "2026-01-01T00:00:00Z");

    const late = await mcp(p.mcpToken, "create_entry", {
      collection: "slots",
      data: { when: "2027-01-01T00:00:00Z" },
    });
    assert.ok(!late.ok && /must be on or before 2026-12-31/.test(late.errorText), late.errorText);
  });

  it("integer: rejects fractional values and fractional increments", async () => {
    const frac = await mcp(p.mcpToken, "create_entry", {
      collection: "slots",
      data: { when: "2026-03-01T00:00:00Z", seats: 1.5 },
    });
    assert.ok(!frac.ok && /seats: must be an integer/.test(frac.errorText), frac.errorText);

    const ok = await mcp(p.mcpToken, "create_entry", {
      collection: "slots",
      data: { when: "2026-03-01T00:00:00Z", seats: 10 },
    });
    assert.ok(ok.ok, ok.errorText);

    const fracInc = await mcp(p.mcpToken, "update_entry_if", {
      collection: "slots",
      id: ok.value.id,
      increment: { field: "seats", by: 0.5 },
    });
    assert.ok(!fracInc.ok && /by must be a whole number for integer field "seats"/.test(fracInc.errorText), fracInc.errorText);

    const wholeInc = await mcp(p.mcpToken, "update_entry_if", {
      collection: "slots",
      id: ok.value.id,
      increment: { field: "seats", by: -1 },
    });
    assert.ok(wholeInc.ok, wholeInc.errorText);
  });

  it("unique dates collide across offsets; values stored canonical UTC", async () => {
    const first = await mcp(p.mcpToken, "create_entry", {
      collection: "slots",
      data: { when: "2026-07-04T10:00:00+02:00" },
    });
    assert.ok(first.ok, first.errorText);
    assert.equal(first.value.data.when, "2026-07-04T08:00:00.000Z");

    const sameInstant = await mcp(p.mcpToken, "create_entry", {
      collection: "slots",
      data: { when: "2026-07-04T08:00:00.000Z" },
    });
    assert.ok(!sameInstant.ok && /when: value already exists/.test(sameInstant.errorText), sameInstant.errorText);
    const issues = issuesOf(sameInstant.errorText);
    assert.equal(issues[0].constraint, "unique");
  });

  it("list and single-entry delivery gates agree on non-UTC publicFilter dates", async () => {
    // publicFilter eq uses a +02:00 offset; the stored value is canonical UTC.
    // SQL (list) compares ::timestamptz instants — the JS gate (single) must agree.
    const rows = await mcp(p.mcpToken, "query_entries", {
      collection: "slots",
      where: [{ field: "when", op: "eq", value: "2026-07-04T08:00:00.000Z" }],
    });
    const id = rows.value.entries[0].id;

    const list = await delivery(p.deliveryToken, "/slots");
    assert.equal(list.status, 200);
    assert.equal(list.json.data.length, 1, "list should serve the matching row");
    assert.equal(list.json.data[0].id, id);

    const single = await delivery(p.deliveryToken, `/slots/${id}`);
    assert.equal(single.status, 200, "single GET must agree with the list gate");
  });

  it("MCP gt/lt date filters match normalized values from any offset", async () => {
    const hit = await mcp(p.mcpToken, "query_entries", {
      collection: "slots",
      where: [{ field: "when", op: "gt", value: "2026-07-04T09:30:00+02:00" }],
    });
    assert.ok(hit.ok, hit.errorText);
    assert.equal(hit.value.entries.length, 1);

    const miss = await mcp(p.mcpToken, "query_entries", {
      collection: "slots",
      where: [{ field: "when", op: "gt", value: "2026-07-05T00:00:00Z" }],
    });
    assert.equal(miss.value.entries.length, 0);
  });

  it("meta-validation: bad date bounds, integer misplacement, string bounds on text", async () => {
    const badBound = await mcp(p.mcpToken, "define_collection", {
      name: "bad_d1",
      fields: [{ name: "d", label: "D", type: "date", min: "not-a-date" }],
    });
    assert.ok(!badBound.ok && /date min must be a parseable ISO date string/.test(badBound.errorText), badBound.errorText);

    const intOnText = await mcp(p.mcpToken, "define_collection", {
      name: "bad_d2",
      fields: [{ name: "t", label: "T", type: "text", integer: true }],
    });
    assert.ok(!intOnText.ok && /integer is only valid on number fields/.test(intOnText.errorText), intOnText.errorText);

    const strOnText = await mcp(p.mcpToken, "define_collection", {
      name: "bad_d3",
      fields: [{ name: "t", label: "T", type: "text", max: "10" }],
    });
    assert.ok(!strOnText.ok && /min\/max must be numbers on text fields/.test(strOnText.errorText), strOnText.errorText);

    const invertedDates = await mcp(p.mcpToken, "define_collection", {
      name: "bad_d4",
      fields: [{ name: "d", label: "D", type: "date", min: "2026-12-01T00:00:00Z", max: "2026-01-01T00:00:00Z" }],
    });
    assert.ok(!invertedDates.ok && /min must be <= max/.test(invertedDates.errorText), invertedDates.errorText);
  });
});

describe("tightening warnings (A4) + null-unset (A6)", () => {
  let p;
  const issuesOf = (errorText) => {
    const line = errorText.split("\nissues: ")[1];
    return line ? JSON.parse(line) : null;
  };
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("tighten");
  });
  after(() => p.destroy());

  it("tightening min + adding pattern warns with violation counts; old rows stay readable", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "score", label: "Score", type: "number", publicRead: true },
        { name: "tag", label: "Tag", type: "text", publicRead: true },
      ],
    });
    assert.ok(def.ok, def.errorText);
    const seed = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [
        { score: 1, tag: "ok_one" },
        { score: 2, tag: "BAD TAG" },
        { score: 5, tag: "ok_two" },
      ],
    });
    assert.ok(seed.ok, seed.errorText);

    const tightened = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "score", label: "Score", type: "number", publicRead: true, min: 3 },
        { name: "tag", label: "Tag", type: "text", publicRead: true, max: 20, pattern: "^[a-z_]+$" },
      ],
    });
    assert.ok(tightened.ok, tightened.errorText);
    const warnings = tightened.value.constraintWarnings;
    assert.ok(Array.isArray(warnings), "constraintWarnings missing: " + JSON.stringify(tightened.value));
    const byKey = Object.fromEntries(warnings.map((w) => [`${w.field}:${w.constraint}`, w]));
    assert.equal(byKey["score:min"].existingViolations, 2);
    assert.equal(byKey["tag:pattern"].existingViolations, 1);
    assert.equal(byKey["tag:pattern"].scannedRows, 3);

    // Old violating rows stay readable via MCP and delivery…
    const rows = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "score", op: "eq", value: 1 }],
    });
    assert.equal(rows.value.entries.length, 1);
    const list = await delivery(p.deliveryToken, "/posts");
    assert.equal(list.json.data.length, 3);

    // …while a new violating write fails.
    const blocked = await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: { score: 1 },
    });
    assert.ok(!blocked.ok && /score: must be >= 3/.test(blocked.errorText), blocked.errorText);
  });

  it("enum option removal counts stranded rows", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "moods",
      fields: [{ name: "mood", label: "Mood", type: "enum", options: ["happy", "sad", "angry"] }],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "moods",
      entries: [{ mood: "happy" }, { mood: "angry" }, { mood: "angry" }],
    });
    const narrowed = await mcp(p.mcpToken, "define_collection", {
      name: "moods",
      fields: [{ name: "mood", label: "Mood", type: "enum", options: ["happy", "sad"] }],
    });
    assert.ok(narrowed.ok, narrowed.errorText);
    const w = narrowed.value.constraintWarnings.find((x) => x.field === "mood");
    assert.equal(w.constraint, "enum");
    assert.equal(w.existingViolations, 2);
  });

  it("null unsets optional fields via update_entry; required fields reject null", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      publicWrite: false,
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "body", label: "Body", type: "text", publicRead: true },
      ],
    });
    const created = await mcp(p.mcpToken, "create_entry", {
      collection: "notes",
      data: { title: "t1", body: "scratch" },
    });
    assert.ok(created.ok, created.errorText);

    const unset = await mcp(p.mcpToken, "update_entry", {
      collection: "notes",
      id: created.value.id,
      data: { body: null },
    });
    assert.ok(unset.ok, unset.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "notes", id: created.value.id });
    assert.ok(!("body" in got.value.data), "body should be gone: " + JSON.stringify(got.value.data));

    const reject = await mcp(p.mcpToken, "update_entry", {
      collection: "notes",
      id: created.value.id,
      data: { title: null },
    });
    assert.ok(!reject.ok && /title: field is required and cannot be unset/.test(reject.errorText), reject.errorText);
    const issues = issuesOf(reject.errorText);
    assert.equal(issues[0].constraint, "required");
  });

  it("CAS unset via update_entry_if removes the key atomically", async () => {
    const created = await mcp(p.mcpToken, "create_entry", {
      collection: "notes",
      data: { title: "t2", body: "temp" },
    });
    const cas = await mcp(p.mcpToken, "update_entry_if", {
      collection: "notes",
      id: created.value.id,
      if: [{ field: "body", op: "eq", value: "temp" }],
      data: { body: null },
    });
    assert.ok(cas.ok, cas.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "notes", id: created.value.id });
    assert.ok(!("body" in got.value.data), JSON.stringify(got.value.data));
    assert.equal(got.value.data.title, "t2");
  });

  it("create treats explicit null on an OPTIONAL field as unset (symmetry w/ update — feedback #18)", async () => {
    // The natural JSON-client pattern {body: value || null} must not be rejected
    // on create just because it isn't rejected on update.
    const ok = await mcp(p.mcpToken, "create_entry", {
      collection: "notes",
      data: { title: "t3", body: null },
    });
    assert.ok(ok.ok, ok.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "notes", id: ok.value.id });
    assert.ok(!("body" in got.value.data), "null optional stored as absent, not null: " + JSON.stringify(got.value.data));

    // A null on a REQUIRED field still fails — but as the clear 'required' error.
    const bad = await mcp(p.mcpToken, "create_entry", {
      collection: "notes",
      data: { title: null, body: "x" },
    });
    assert.ok(!bad.ok && /title.*required|required.*title/i.test(bad.errorText), bad.errorText);
  });
});

describe("Phase 8 review fixes", () => {
  let p;
  const issuesOf = (errorText) => {
    const line = errorText.split("\nissues: ")[1];
    return line ? JSON.parse(line) : null;
  };
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("p8fixes");
  });
  after(() => p.destroy());

  it("ReDoS: nested-quantifier patterns are rejected at define time", async () => {
    for (const bad of ["^(a+)+$", "(\w+\s?)+", "(a*)*", "(\d+,)*\d+"]) {
      const r = await mcp(p.mcpToken, "define_collection", {
        name: "redos",
        fields: [{ name: "v", label: "V", type: "text", max: 100, pattern: bad }],
      });
      assert.ok(!r.ok && /nested quantifiers/.test(r.errorText), `${bad} should be rejected: ${r.errorText}`);
    }
    // safe patterns still accepted
    const ok = await mcp(p.mcpToken, "define_collection", {
      name: "redos_ok",
      fields: [{ name: "v", label: "V", type: "text", max: 100, pattern: "^[a-z0-9_]{2,29}$" }],
    });
    assert.ok(ok.ok, ok.errorText);
  });

  it("bulk_create_entries per-item failures carry structured issues", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "bulkitems",
      fields: [
        { name: "code", label: "Code", type: "text", required: true, max: 10, pattern: "^[A-Z]+$" },
        { name: "qty", label: "Qty", type: "number", min: 1 },
      ],
    });
    const bulk = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "bulkitems",
      entries: [{ code: "OK" }, { code: "lower" }, { code: "OK2", qty: 0 }],
    });
    assert.ok(bulk.ok, bulk.errorText);
    const items = bulk.value.results;
    assert.ok(items[0].ok, JSON.stringify(items[0]));
    assert.ok(Array.isArray(items[1].issues) && items[1].issues.some((i) => i.field === "code" && i.constraint === "pattern"), JSON.stringify(items[1]));
    assert.ok(Array.isArray(items[2].issues) && items[2].issues.some((i) => i.field === "qty" && i.constraint === "min"), JSON.stringify(items[2]));
  });

  it("integer CAS: a value predating the integer knob conflicts instead of incrementing", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "counters",
      fields: [{ name: "n", label: "N", type: "number" }],
    });
    const created = await mcp(p.mcpToken, "create_entry", { collection: "counters", data: { n: 1.5 } });
    assert.ok(created.ok, created.errorText);

    // Tighten to integer — existing fractional row is warned about, not mutated.
    const tightened = await mcp(p.mcpToken, "define_collection", {
      name: "counters",
      fields: [{ name: "n", label: "N", type: "number", integer: true }],
    });
    assert.ok(tightened.ok, tightened.errorText);
    const w = (tightened.value.constraintWarnings ?? []).find((x) => x.constraint === "integer");
    assert.ok(w && w.existingViolations === 1, JSON.stringify(tightened.value.constraintWarnings));

    // A whole-number increment on the legacy fractional value must CONFLICT.
    const cas = await mcp(p.mcpToken, "update_entry_if", {
      collection: "counters",
      id: created.value.id,
      increment: { field: "n", by: 1 },
    });
    assert.ok(!cas.ok || cas.value?.ok === false, JSON.stringify(cas.value ?? cas.errorText));
  });

  it("tightening scan degrades to scanFailed on legacy mistyped data, define still applies", async () => {
    // text value, then confirm-retype the field to number: the old "abc" stays
    // stored; a subsequent min-tighten can't cast it and must not abort define.
    await mcp(p.mcpToken, "define_collection", {
      name: "retyped",
      fields: [{ name: "amount", label: "Amount", type: "text" }],
    });
    await mcp(p.mcpToken, "create_entry", { collection: "retyped", data: { amount: "abc" } });
    const retype = await mcp(p.mcpToken, "define_collection", {
      name: "retyped",
      fields: [{ name: "amount", label: "Amount", type: "number", min: 5 }],
      confirm: true,
    });
    assert.ok(retype.ok, retype.errorText);
    const w = (retype.value.constraintWarnings ?? []).find((x) => x.field === "amount");
    // Either the cast failed (scanFailed) or it counted — but define APPLIED regardless.
    if (w) assert.ok(w.scanFailed === true || typeof w.existingViolations === "number", JSON.stringify(w));
    assert.equal(retype.value.ok, true);
  });
});

describe("A6 delivery-surface null-unset", () => {
  let p, issuer, alice;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("a6delivery");
    issuer = await startMockIssuer();
    await connectClerk(p.id, issuer.issuer);
    alice = await issuer.tokenFor("user_alice");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "drafts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "body", label: "Body", type: "text", publicRead: true },
        { name: "owner", label: "Owner", type: "text" },
      ],
      access: { read: "owner", write: "owner", ownerField: "owner" },
    });
    assert.ok(def.ok, def.errorText);
  });
  after(async () => {
    await issuer.close();
    await p.destroy();
  });

  it("PATCH body:null unsets via delivery; required title:null is 422; unset key absent from reads", async () => {
    const created = await delivery(p.deliveryToken, "/drafts", {
      method: "POST",
      body: { title: "t", body: "scratch" },
      userToken: alice,
    });
    assert.equal(created.status, 201);
    const id = created.json.id;

    const unset = await delivery(p.deliveryToken, `/drafts/${id}`, {
      method: "PATCH",
      body: { body: null },
      userToken: alice,
    });
    assert.equal(unset.status, 200);
    assert.ok(!("body" in unset.json.data), JSON.stringify(unset.json.data));

    const read = await delivery(p.deliveryToken, `/drafts/${id}`, { userToken: alice });
    assert.equal(read.status, 200);
    assert.ok(!("body" in read.json.data), JSON.stringify(read.json.data));

    const rejectReq = await delivery(p.deliveryToken, `/drafts/${id}`, {
      method: "PATCH",
      body: { title: null },
      userToken: alice,
    });
    assert.equal(rejectReq.status, 422);
    assert.equal(rejectReq.json.code, "E_VALIDATION");
    assert.ok(Array.isArray(rejectReq.json.issues) && rejectReq.json.issues[0].constraint === "required", JSON.stringify(rejectReq.json));
  });
});
