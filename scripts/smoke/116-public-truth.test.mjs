import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// The public surface must not be able to lie about what we ship.
//
// It did. The marketing site advertised "42 tools" against a surface of 61, and
// "8 field primitives" for the entire life of group/array. Nineteen tools were
// absent from the developers page altogether — the whole plugin system, blocks,
// SEO/site audit, inbound email, and mint_delivery_token, which an integrator
// asked us about in writing while our own docs did not mention it.
//
// None of that was deliberate. Every figure was a hand-typed string in a React
// component, so shipping a capability and updating the sentence describing it
// were separate acts and the second stopped happening. lib/field-types.ts had
// already solved this internally — a contract test asserts list_field_types'
// description agrees with FIELD_TYPES.length, "an assertion that cannot rot."
// This suite carries that discipline across the repo boundary to the website.
//
// Method: read the LIVE surface (tools/list, list_field_types) and compare it to
// what the shipped source states. Never hard-code an expected number here —
// a test that hard-codes 61 rots the same way the marketing copy did.
describe("public truth: the website cannot misstate the surface", () => {
  let p;
  let liveTools;
  let livePrimitives;

  const read = (f) => readFileSync(f, "utf8");
  /** Source with comments stripped — a claim inside a comment is not a claim. */
  const code = (f) =>
    read(f)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("public-truth");
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    liveTools = (await res.json()).result.tools.map((t) => t.name);
    const ft = await mcp(p.mcpToken, "list_field_types", {});
    assert.ok(ft.ok, ft.errorText);
    livePrimitives = Object.keys(ft.value.types ?? ft.value);
  });

  it("MCP_TOOL_COUNT equals the number of tools actually served", () => {
    // Stated once in platform-facts because the registry pulls server-only
    // imports and a static page cannot import it. Pinned here instead.
    const src = code("lib/platform-facts.ts");
    const m = src.match(/MCP_TOOL_COUNT = (\d+)/);
    assert.ok(m, "platform-facts must state MCP_TOOL_COUNT");
    assert.equal(
      Number(m[1]),
      liveTools.length,
      `platform-facts says ${m[1]} tools; tools/list serves ${liveTools.length}. ` +
        `Update MCP_TOOL_COUNT — every public page reads it.`,
    );
  });

  it("the tool-group registry covers the live surface EXACTLY", () => {
    // This is the assertion that would have caught the 19 missing tools. It is
    // not about a count: it names which tool is unpublished.
    const src = code("lib/tool-groups.ts");
    const arrays = [...src.matchAll(/tools:\s*\[([\s\S]*?)\]/g)].map((m) => m[1]);
    const grouped = arrays.flatMap((a) => [...a.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));

    const missing = liveTools.filter((t) => !grouped.includes(t));
    assert.deepEqual(
      missing,
      [],
      `these tools ship but appear on NO public page — file each into a group in lib/tool-groups.ts: ${missing.join(", ")}`,
    );
    const phantom = grouped.filter((t) => !liveTools.includes(t));
    assert.deepEqual(phantom, [], `the registry advertises tools that no longer exist: ${phantom.join(", ")}`);

    const dupes = grouped.filter((t, i) => grouped.indexOf(t) !== i);
    assert.deepEqual(dupes, [], `a tool is filed into two groups: ${dupes.join(", ")}`);
  });

  it("FIELD_PRIMITIVE_COUNT is derived, not typed", () => {
    // Derived from FIELD_TYPES, so it cannot drift — assert that it stays
    // derived. A future edit replacing it with a literal reintroduces the bug.
    const src = code("lib/platform-facts.ts");
    assert.match(
      src,
      /FIELD_PRIMITIVE_COUNT = FIELD_TYPES\.length/,
      "FIELD_PRIMITIVE_COUNT must be computed from FIELD_TYPES, never written as a number",
    );
    assert.equal(livePrimitives.length, 10, "sanity: list_field_types returns the primitives it documents");
  });

  it("no public page contains a hand-typed count of a fact we own", () => {
    // The mechanism, not just today's values.
    //
    // The FIRST version of this test only caught a digit sitting immediately
    // before its noun, and so it passed while the site footer said "42 MCP
    // tools · 458 smoke tests green" on every single page, and the home-page
    // hero rendered <CountUp to={42} /> with the words "MCP tools" on the NEXT
    // line. Two of the most-read surfaces we have. Hence two detectors:
    // markup-tolerant proximity, and any numeric literal handed to CountUp.
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    walk("components/marketing");
    walk("app/(marketing)");

    const NOUNS = "tools|primitives|field primitives|groups|smoke tests|tests green|endpoint families|endpoints";
    const offenders = [];
    for (const f of files) {
      const src = code(f);

      // (a) a literal fed to the CountUp stat component — the hero's failure mode.
      for (const m of src.matchAll(/<CountUp\s+to=\{(\d+)\}/g)) {
        offenders.push(`${f} — <CountUp to={${m[1]}}> must take an imported fact`);
      }

      // (b) a digit within ~40 chars of one of our nouns, tolerating JSX tags
      //     and newlines in between (which is what hid the footer for months).
      const flat = src.replace(/\s+/g, " ");
      for (const m of flat.matchAll(new RegExp(`(?<![\\w/])(\\d+)((?:</?[^>]{0,80}>|[^<>\\d]){0,40}?)\\b(${NOUNS})\\b`, "g"))) {
        // A jsx expression like {MCP_TOOL_COUNT} leaves no digit, so anything
        // matching here really is typed. Skip obvious non-claims (years, px).
        if (/px|rem|em\b|20\d\d/.test(m[0])) continue;
        offenders.push(`${f} — "${m[0].slice(0, 70)}"`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "import the value from @/lib/platform-facts instead of typing it:\n  " + offenders.join("\n  "),
    );
  });

  it("DELIVERY_ENDPOINTS matches the routes that actually exist", () => {
    // Pinned to the filesystem: adding an endpoint fails until the number moves.
    const walk = (dir) => {
      let n = 0;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) n += walk(`${dir}/${e.name}`);
        else if (e.name === "route.ts") n += 1;
      }
      return n;
    };
    const actual = walk("app/api/v1");
    const m = code("lib/platform-facts.ts").match(/DELIVERY_ENDPOINTS = (\d+)/);
    assert.ok(m, "platform-facts must state DELIVERY_ENDPOINTS");
    assert.equal(Number(m[1]), actual, `platform-facts says ${m[1]} delivery endpoints; ${actual} route.ts files exist under app/api/v1`);
  });

  it("the advertised test-count FLOOR is below the real count, but not far below", () => {
    // Both directions. Below the floor = we oversell. Far above = we are back to
    // advertising less than half the suite, which is the bug this replaced.
    const files = readdirSync("scripts/smoke").filter((f) => f.endsWith(".test.mjs"));
    let actual = 0;
    for (const f of files) actual += (readFileSync(`scripts/smoke/${f}`, "utf8").match(/^\s*it\(/gm) ?? []).length;

    const m = code("lib/platform-facts.ts").match(/SMOKE_TEST_FLOOR = (\d+)/);
    assert.ok(m, "platform-facts must state SMOKE_TEST_FLOOR");
    const floor = Number(m[1]);
    assert.ok(floor <= actual, `we advertise ${floor}+ smoke tests but only ${actual} exist — never oversell`);
    assert.ok(
      actual - floor < 150,
      `the suite has grown to ${actual} while we still advertise ${floor}+ — raise the floor (this is exactly how "458" happened)`,
    );
  });

  it("the rate limits the site quotes are the ones the code enforces", () => {
    // platform-facts OWNS these and the implementations import them, so this
    // asserts the inversion is intact rather than comparing two copies.
    assert.match(
      code("lib/ratelimit.ts"),
      /const MAX_PER_WINDOW = DELIVERY_REQUESTS_PER_WINDOW/,
      "ratelimit.ts must take its ceiling from platform-facts, not define its own",
    );
    assert.match(
      code("lib/ratelimit.ts"),
      /const WINDOW_MS = RATE_WINDOW_MS/,
      "…and its window too",
    );
    assert.match(
      code("app/api/mcp/route.ts"),
      /max: MCP_CALLS_PER_WINDOW/,
      "the MCP route must take its ceiling from platform-facts",
    );
    assert.match(
      code("lib/image-transform.ts"),
      /IMAGE_BURST_PER_IP = IMAGE_TRANSFORMS_PER_WINDOW_PER_IP/,
      "the image burst must take its ceiling from platform-facts",
    );
  });
});
