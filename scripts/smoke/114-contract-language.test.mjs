import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// CONTRACT-1 — the agent-facing language pass.
//
// Same contract as suite 108: read the live surface the way an agent does
// (tools/list + get_project_info + list_field_types), assert the corrected
// words, and where the claim is BEHAVIORAL pin it to the wire in the same file.
// A description that merely reads well is how WP-3's lie survived for months.
//
// 114a — the FIELD + QUERY vocabulary. Every defect here was a shipped
// capability the contract kept invisible or mis-enumerated:
//   · list_field_types said "the 8 field primitives" and named 8 while
//     RETURNING 10 — group/array shipped in DM-1 and never reached the words.
//   · capacity (DM-3, bea3377) appeared in the payload ONLY inside writeOnly's
//     incompatibility list: the word with no definition anywhere.
//   · query_entries/aggregate_entries enumerated 7 of the 9 real ops, omitting
//     the two an exclusion filter and an array filter actually need.

describe("CONTRACT-1 — field + query vocabulary matches the wire", () => {
  let p;
  let tools;
  let fieldTypes;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("contract-lang");
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = await res.json();
    assert.ok(body.result?.tools?.length > 0, "tools/list must answer");
    tools = new Map(body.result.tools.map((t) => [t.name, t]));
    const r = await mcp(p.mcpToken, "list_field_types", {});
    assert.ok(r.ok, r.errorText);
    fieldTypes = r.value;
  });
  after(() => p.destroy());

  it("the primitive COUNT in the description equals what the tool returns, and the containers are named", () => {
    const desc = tools.get("list_field_types").description;
    const actual = Object.keys(fieldTypes.types);
    // The bug this replaces: a hard-coded "8" that stayed 8 across DM-1.
    assert.match(
      desc,
      new RegExp(`\\b${actual.length} field primitives\\b`),
      `description must say "${actual.length} field primitives" — it returns ${actual.length}: ${actual.join(", ")}`,
    );
    // …and EVERY returned type must be named in the description. This is the
    // assertion that cannot rot: add an 11th primitive and it fails until the
    // words follow.
    for (const t of actual) {
      assert.ok(desc.includes(t), `type "${t}" is returned by list_field_types but not named in its description`);
    }
    // The containers specifically — they are what an agent needs to know EXISTS
    // before it flattens a repeater into 5 numbered text fields.
    assert.match(desc, /group/);
    assert.match(desc, /array/);
  });

  it("FIXTURE CHECK: the description does not still claim 8 — the exact stale number is pinned out", () => {
    // Negative control for the assertion above: without this, changing the
    // regex source would let "8 field primitives" back in silently.
    const desc = tools.get("list_field_types").description;
    assert.ok(
      !/\b8 field primitives\b/.test(desc),
      "the pre-CONTRACT-1 count is back — group and array are invisible again",
    );
  });

  it("capacity is DEFINED in commonConfig, not just mentioned as an incompatibility", () => {
    const common = fieldTypes.commonConfig;
    assert.ok(Array.isArray(common), "list_field_types must return commonConfig");
    const entry = common.find((c) => c.startsWith("capacity?:"));
    assert.ok(
      entry,
      "capacity has no commonConfig entry — before this fix the ONLY occurrence of the word " +
        "in the whole payload was inside writeOnly's incompatibility list, which teaches nothing",
    );
    assert.match(entry, /AT MOST N/, "the semantic must be stated: unique is 1, capacity is N");
    assert.match(entry, /unique/, "the unique conflict is the first thing a modeler trips on");
    // The race argument is WHY this is a platform primitive rather than app code.
    assert.match(entry, /count-then-insert/);
  });

  it("BEHAVIORAL PIN: capacity:2 admits exactly 2 and refuses the 3rd, naming the remedy", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "seats",
      fields: [
        { name: "slot", label: "Slot", type: "text", capacity: 2 },
        { name: "who", label: "Who", type: "text", required: true },
      ],
    });
    assert.ok(def.ok, def.errorText);
    for (const who of ["a", "b"]) {
      const r = await mcp(p.mcpToken, "create_entry", { collection: "seats", data: { slot: "9am", who } });
      assert.ok(r.ok, `booking ${who} should fit under capacity 2: ${r.errorText}`);
    }
    const third = await mcp(p.mcpToken, "create_entry", { collection: "seats", data: { slot: "9am", who: "c" } });
    assert.ok(!third.ok, "the 3rd booking must be refused — capacity:2 is the whole claim");
    // Assert the REASON, never just failure (negative-control discipline): a
    // required-field or unknown-field error would otherwise pass this test.
    assert.match(third.errorText, /E_VALIDATION/);
    assert.match(third.errorText, /full|capacity/i, `the refusal must say why: ${third.errorText}`);
    assert.match(third.errorText, /at most 2/, "the limit is named, so the fix needs no second call");
    // Positive control: a DIFFERENT key is unaffected — the constraint is
    // per-value, not per-collection.
    const other = await mcp(p.mcpToken, "create_entry", { collection: "seats", data: { slot: "10am", who: "c" } });
    assert.ok(other.ok, `capacity is per-KEY; a different slot must still admit writes: ${other.errorText}`);
  });

  it("BEHAVIORAL PIN: a cancellation frees a seat — the commonConfig claim about trashed rows", async () => {
    // The claim in commonConfig is that the count is of LIVE rows. That is only
    // true because delete_entry MOVES the row to entries_trash rather than
    // flagging it in place — a soft-delete column would have made the sentence
    // false. Verified here rather than by reading the trigger.
    const list = await mcp(p.mcpToken, "query_entries", {
      collection: "seats",
      where: [{ field: "slot", op: "eq", value: "9am" }],
    });
    assert.ok(list.ok, list.errorText);
    assert.equal(list.value.entries.length, 2, "fixture: the 9am slot is full");
    const del = await mcp(p.mcpToken, "delete_entry", { collection: "seats", id: list.value.entries[0].id });
    assert.ok(del.ok, del.errorText);
    const refill = await mcp(p.mcpToken, "create_entry", { collection: "seats", data: { slot: "9am", who: "d" } });
    assert.ok(
      refill.ok,
      `a cancelled booking must free its seat — commonConfig says so: ${refill.errorText}`,
    );
  });

  it("the where-op enumerations in prose match WHERE_OPS exactly — no op is invisible", () => {
    // The ops live in lib/query.ts; the JSON schema derives from it, but the
    // DESCRIPTIONS were hand-typed and drifted. Read the real list from the
    // schema the same tool serves, then demand the prose covers it.
    const schemaOps = tools.get("query_entries").inputSchema.properties.where.items.oneOf[0].properties.op.enum;
    assert.ok(schemaOps.length >= 9, `expected the full op set, got ${schemaOps.join("|")}`);
    for (const name of ["query_entries", "aggregate_entries"]) {
      const desc = tools.get(name).description;
      for (const op of schemaOps) {
        assert.ok(
          new RegExp(`\\b${op}\\b`).test(desc),
          `${name}'s description omits op "${op}" — an agent that reads only the description cannot reach it`,
        );
      }
    }
  });

  it("BEHAVIORAL PIN: the two newly-listed ops really work (has + neOrUnset)", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "ops_check",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "tags", label: "Tags", type: "array", item: { type: "text" } },
        { name: "opted_out", label: "O", type: "boolean" },
      ],
    });
    assert.ok(def.ok, def.errorText);
    await mcp(p.mcpToken, "create_entry", {
      collection: "ops_check",
      data: { title: "tagged+optout", tags: ["rust", "go"], opted_out: true },
    });
    await mcp(p.mcpToken, "create_entry", { collection: "ops_check", data: { title: "unset-flag", tags: ["rust"] } });

    const has = await mcp(p.mcpToken, "query_entries", {
      collection: "ops_check",
      where: [{ field: "tags", op: "has", value: "go" }],
    });
    assert.ok(has.ok, has.errorText);
    assert.equal(has.value.entries.length, 1, "has = array membership");

    // The point of documenting neOrUnset: `ne` silently drops the unset row.
    const ne = await mcp(p.mcpToken, "query_entries", {
      collection: "ops_check",
      where: [{ field: "opted_out", op: "ne", value: true }],
    });
    assert.ok(ne.ok, ne.errorText);
    assert.equal(ne.value.entries.length, 0, "ne is SET-and-different — this is the trap the words now warn about");
    const nou = await mcp(p.mcpToken, "query_entries", {
      collection: "ops_check",
      where: [{ field: "opted_out", op: "neOrUnset", value: true }],
    });
    assert.ok(nou.ok, nou.errorText);
    assert.equal(nou.value.entries.length, 1, "neOrUnset keeps the never-set row — what an exclusion filter means");
  });

  it("SELF-CHECK: FIELD_TYPES in the source and the served payload agree", () => {
    // Cheap guard against the reverse drift — a primitive added to the type
    // union but never given a spec would serve a payload missing a key.
    const src = readFileSync("lib/field-types.ts", "utf8");
    const block = /export const FIELD_TYPES = \[([\s\S]*?)\] as const;/.exec(src);
    assert.ok(block, "could not read FIELD_TYPES");
    const declared = [...block[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      Object.keys(fieldTypes.types).sort(),
      declared.sort(),
      "every declared primitive needs a FIELD_TYPE_SPECS entry, and vice versa",
    );
  });
});
