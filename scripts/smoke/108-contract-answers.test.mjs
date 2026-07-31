import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// CP10 ANSWER batch — WP-3, WP-4, QRY-3. Each was a CONTRACT defect: the code
// was right and the words were wrong (or absent), and an agent plans against the
// words. An ANSWER closes with "copy merged + a test asserting it" (BURNDOWN),
// and this file is that test: it reads the live contract the way an agent does
// (tools/list + get_project_info) and asserts the corrected claims are present —
// so the next person to edit a description cannot silently regrow the lie.
//
// Where a claim is about BEHAVIOR, the behavioral test already exists elsewhere
// and is named next to the assertion — this file pins the words to it.

describe("CP10 — contract answers stay answered", () => {
  let p;
  let tools; // name -> description (+ the full defs for schema digs)
  let info;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("contract-answers");
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = await res.json();
    assert.ok(body.result?.tools?.length > 0, "tools/list must answer");
    tools = new Map(body.result.tools.map((t) => [t.name, t]));
    const r = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(r.ok, r.errorText);
    info = r.value;
  });
  after(() => p.destroy());

  /** The hooks/workflow prose lives in define_collection's INPUT SCHEMA. */
  const defineSchemaText = () => JSON.stringify(tools.get("define_collection").inputSchema);

  it("WP-3: the hooks description tells the PER-ITEM truth about bulk — the old lie is gone", () => {
    const text = defineSchemaText();
    // The lie: "NOT bulk_create_entries (refused)". Behavior (since I5, proven by
    // scripts/smoke/43-bulk-hooks.test.mjs): the hook runs per item, bounded
    // concurrency, budget-derived cap.
    assert.ok(
      !/NOT bulk_create_entries \(refused\)/.test(text),
      "the contradiction is back: the contract claims bulk refuses hooks while the code runs them per item",
    );
    assert.match(text, /bulk_create_entries — bulk consults the hook PER ITEM/);
    assert.match(text, /bounded concurrency/);
    assert.match(text, /timeoutMs/, "the cap's derivation is part of the story — it names the knob that moves it");
  });

  it("WP-4: same-state workflow semantics are stated, with the CAS exception and its reason", () => {
    const text = defineSchemaText();
    assert.match(text, /idempotent NO-OP on update_entry/);
    assert.match(text, /update_entry_if is the DELIBERATE exception/);
    assert.match(text, /E_CONFLICT/);
    // The reason is load-bearing: without it the asymmetry reads as a bug.
    assert.match(text, /exactly ONE winner/);
    // ...and the escape hatch, so the doc self-corrects the retry loop it predicts.
    assert.match(text, /`if` condition instead of re-sending the state/);
  });

  it("QRY-3: the budgets are published where an agent orients", async () => {
    const limits = info.deliveryApi?.limits;
    assert.ok(limits, "get_project_info.deliveryApi.limits must exist");
    assert.match(limits, /20 requests per MINUTE per IP/);
    assert.match(limits, /Retry-After/);
    assert.match(limits, /E_RATE_LIMITED/);
    assert.match(limits, /1 MiB \(413\)/);
    assert.match(limits, /10 MB per file/);
    assert.match(limits, /300 tool calls\/min per project/);

  });

  it("QRY-3: the published 1 MiB body cap is the real one — a bigger body answers 413", async () => {
    // Behavioral pin, not a constant import: if the cap moves and the contract
    // doesn't, THIS fails — a published wrong number is worse than none.
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "capped",
      publicWrite: true,
      fields: [{ name: "body", label: "B", type: "richtext", publicRead: true }],
    });
    assert.ok(def.ok, def.errorText);
    const res = await fetch(`${BASE}/api/v1/capped`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "x".repeat((1 << 20) + 1024) }), // just past 1 MiB
    });
    assert.equal(res.status, 413, "the contract publishes 1 MiB — the wire must agree");
    // And a body comfortably UNDER the cap is accepted — the positive control
    // that proves 413 above came from the cap, not from something else broken.
    const ok = await fetch(`${BASE}/api/v1/capped`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "y".repeat(64 * 1024) }),
    });
    assert.equal(ok.status, 201, `a 64 KiB body must pass (got ${ok.status})`);
  });

  it("QRY-3: the published delivery budget is the real one — a 21st write in a minute answers 429 with Retry-After", async () => {
    // One shared IP on purpose (helpers randomize by default to keep tests
    // decoupled) — this test IS about the limiter. Collection first:
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "paced",
      publicWrite: true,
      fields: [{ name: "note", label: "N", type: "text", publicRead: true }],
    });
    assert.ok(def.ok, def.errorText);
    const ip = "203.0.113.77";
    let got429 = null;
    // Up to 60 attempts, counted per wall-clock minute bucket (mirroring
    // expectRateLimit429's cap): a window boundary mid-run resets the count, and
    // guaranteeing 21 requests land in ONE bucket needs up to 41 attempts — the
    // first version capped at 25 and flaked on exactly the straddle its own
    // comment predicted. Only >20 successes in a single bucket is a real failure.
    const perBucket = new Map();
    for (let i = 0; i < 60 && !got429; i++) {
      const bucket = Math.floor(Date.now() / 60_000);
      const res = await fetch(`${BASE}/api/v1/paced`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${p.deliveryToken}`,
          "content-type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ note: `n${i}` }),
      });
      if (res.status === 429) {
        got429 = res;
        break;
      }
      const n = (perBucket.get(bucket) ?? 0) + 1;
      perBucket.set(bucket, n);
      assert.ok(n <= 20, `request ${n} in one minute bucket succeeded — the published budget of 20 is wrong`);
    }
    assert.ok(got429, "never hit 429 in 60 attempts — the limiter is off or the budget is far above the published 20");
    assert.ok(got429.headers.get("retry-after"), "the 429 must carry Retry-After, as published");
    const body = await got429.json();
    assert.equal(body.code, "E_RATE_LIMITED", "the 429 must carry the published code");
  });
});
