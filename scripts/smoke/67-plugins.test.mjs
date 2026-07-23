import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// Track 2: the plugin system — ONE installable unit (structure + tools +
// guidance + acceptance). Discovery is AI-first via MCP; enabling is
// idempotent; applying = the AI reconciles the baseline via define_collection
// (simulated here) and verifies the acceptance criteria.
describe("plugin system (Track 2)", () => {
  let p;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("plugins");
  });

  it("list_plugins shows the catalog with enabled=false", async () => {
    const r = await mcp(p.mcpToken, "list_plugins", {});
    assert.ok(r.ok, r.errorText);
    const cf = r.value.find((x) => x.id === "contact_forms");
    assert.ok(cf, "contact_forms must be in the catalog");
    assert.equal(cf.enabled, false);
    assert.equal(cf.ingredients.structure, true);
    assert.equal(cf.ingredients.guidance, true);
  });

  it("get_plugin returns the full spec (intent + baseline + reconcile + acceptance)", async () => {
    const r = await mcp(p.mcpToken, "get_plugin", { id: "contact_forms" });
    assert.ok(r.ok, r.errorText);
    assert.ok(r.value.structure.intent.length > 0);
    assert.ok(Array.isArray(r.value.structure.baseline));
    assert.match(r.value.structure.reconcile, /extend/i);
    assert.ok(r.value.acceptance.length >= 3);
    assert.equal(r.value.enabled, false);
  });

  it("unknown plugin ids error helpfully", async () => {
    const r = await mcp(p.mcpToken, "get_plugin", { id: "nope" });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /unknown plugin/i);
  });

  it("enable is idempotent and reflected in list_plugins", async () => {
    const e1 = await mcp(p.mcpToken, "enable_plugin", { id: "contact_forms" });
    assert.ok(e1.ok, e1.errorText);
    assert.match(e1.value.next, /reconcile/i);
    const e2 = await mcp(p.mcpToken, "enable_plugin", { id: "contact_forms" });
    assert.ok(e2.ok, "double-enable must not error");
    const list = await mcp(p.mcpToken, "list_plugins", {});
    const cf = list.value.find((x) => x.id === "contact_forms");
    assert.equal(cf.enabled, true);
    // PLUG-3: enabled ≠ applied. Nothing has been reconciled yet, so the
    // structure must NOT read as present just because the flag flipped.
    assert.equal(cf.applied.status, "none", JSON.stringify(cf.applied));
    assert.equal(cf.applied.matched, 0);
    assert.match(cf.applied.nextAction, /UNAPPLIED/);
    // A plugin that is not enabled has nothing to have applied.
    assert.equal(list.value.find((x) => !x.enabled).applied, undefined);
  });

  it("the AI-apply path: baseline reconciled via define_collection, acceptance holds", async () => {
    // Simulate the agent applying the plugin: fetch the spec, apply the
    // baseline (a fresh project — nothing to merge), then verify acceptance.
    const spec = await mcp(p.mcpToken, "get_plugin", { id: "contact_forms" });
    const inbox = spec.value.structure.baseline[0];
    const def = await mcp(p.mcpToken, "define_collection", {
      name: inbox.name,
      displayName: inbox.displayName,
      publicWrite: inbox.publicWrite,
      fields: inbox.fields,
    });
    assert.ok(def.ok, def.errorText);

    // Acceptance 3: anonymous POST with submitter fields → 201.
    const post = await delivery(p.deliveryToken, "/inbox", {
      method: "POST",
      body: { name: "Ada", email: "ada@example.com", message: "Hello there" },
    });
    assert.equal(post.status, 201, JSON.stringify(post.json));

    // Acceptance 2: anonymous POST setting the moderation field → 403.
    const forged = await delivery(p.deliveryToken, "/inbox", {
      method: "POST",
      body: { name: "Eve", email: "eve@example.com", message: "hi", status: "replied" },
    });
    assert.equal(forged.status, 403, JSON.stringify(forged.json));

    // Acceptance 1+3: the row is visible via query_entries (trusted read).
    const rows = await mcp(p.mcpToken, "query_entries", { collection: "inbox" });
    assert.ok(rows.ok, rows.errorText);
    assert.equal(rows.value.entries?.length ?? rows.value.length, 1);

    // PLUG-3: now that the baseline IS reconciled, applied-state flips to full.
    // Reads FRESH, so it must flip immediately — not after a 15s cache window.
    const list = await mcp(p.mcpToken, "list_plugins", {});
    const applied = list.value.find((x) => x.id === "contact_forms").applied;
    assert.equal(applied.status, "full", JSON.stringify(applied));
    assert.equal(applied.matched, applied.of);
    assert.deepEqual(applied.unmatched, []);
  });

  // PLUG-3, the case that decided the design. A baseline is ADAPTED, not
  // stamped, so a partially-name-matching project is AMBIGUOUS: it may be
  // mid-apply, or it may be a finished install whose collections were merged /
  // renamed during reconciliation. Measured on production: countryside_crm
  // scores 5/6 against CSLP because its `reps` baseline was correctly realized
  // as `users`. So the middle state must say CHECK, never "re-apply" — a
  // re-apply of a live baseline can trip the destructive-change gate.
  it("a partly-reconciled structure reads as UNCLEAR, and says check-don't-reapply", async () => {
    const q = await createEphemeralProject("plug3-unclear");
    try {
      const e = await mcp(q.mcpToken, "enable_plugin", { id: "auth_kit" });
      assert.ok(e.ok, e.errorText);

      const spec = await mcp(q.mcpToken, "get_plugin", { id: "auth_kit" });
      const baseline = spec.value.structure.baseline;
      assert.ok(baseline.length >= 3, "this test needs a multi-collection baseline");

      // Realize exactly ONE baseline collection — the rest stay unmatched.
      const first = baseline[0];
      const def = await mcp(q.mcpToken, "define_collection", {
        name: first.name,
        displayName: first.displayName,
        fields: first.fields,
      });
      assert.ok(def.ok, def.errorText);

      const list = await mcp(q.mcpToken, "list_plugins", {});
      const applied = list.value.find((x) => x.id === "auth_kit").applied;
      assert.equal(applied.status, "unclear", JSON.stringify(applied));
      assert.equal(applied.matched, 1);
      assert.equal(applied.of, baseline.length);
      assert.equal(applied.unmatched.length, baseline.length - 1);
      assert.ok(!applied.unmatched.includes(first.name));
      // The wording is the safety feature: reconciliation is named as the
      // likely explanation, and the instruction is to verify, not to re-apply.
      assert.match(applied.nextAction, /ADAPTED, not stamped/);
      assert.match(applied.nextAction, /BEFORE re-applying/);
      assert.match(applied.nextAction, /destructive-change gate/);
    } finally {
      await q.destroy();
    }
  });

  it("disable keeps content, flips the flag", async () => {
    const d = await mcp(p.mcpToken, "disable_plugin", { id: "contact_forms" });
    assert.ok(d.ok, d.errorText);
    const list = await mcp(p.mcpToken, "list_plugins", {});
    assert.equal(list.value.find((x) => x.id === "contact_forms").enabled, false);
    const rows = await mcp(p.mcpToken, "query_entries", { collection: "inbox" });
    assert.ok(rows.ok, "content created by the plugin must remain");
  });
});
