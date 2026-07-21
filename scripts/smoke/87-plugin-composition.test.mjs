import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql } from "./helpers.mjs";

// Plugin Bases Plan, Track A — the composition core: provides/requires on
// defs, ONE active provider per capability (new enables only — grandfather
// rule), explicit swap, requires auto-resolution, and legacy defs composing
// freely. Uses project-scoped defs so the shared catalog is untouched.
describe("plugin composition core (provides/requires/one-provider)", () => {
  let p;

  const def = (id, extra = {}) => ({
    id,
    version: "0.1.0",
    name: id,
    description: `test def ${id}`,
    guidance: "test",
    ...extra,
  });

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("composition");
    for (const d of [
      def("cap_inbox_a", { provides: "test_inbox" }),
      def("cap_inbox_b", { provides: "test_inbox" }),
      def("cap_sched", { provides: "test_sched" }),
      def("needs_inbox", { provides: "test_crm", requires: ["test_inbox"] }),
      def("needs_sched", { requires: ["test_sched"] }),
      def("needs_ghost", { requires: ["test_ghost"] }),
      def("legacy_free", {}),
    ]) {
      const r = await mcp(p.mcpToken, "define_plugin", { definition: d });
      assert.ok(r.ok, `${d.id}: ${r.errorText}`);
    }
  });
  after(() => p.destroy());

  it("authoring: bad capability tokens are rejected", async () => {
    const r = await mcp(p.mcpToken, "define_plugin", {
      definition: def("bad_caps", { provides: "Not A Token" }),
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /snake_case/i, r.errorText);
  });

  it("one-provider rule: second provider of an active capability is E_CONFLICT with the swap path", async () => {
    const first = await mcp(p.mcpToken, "enable_plugin", { id: "cap_inbox_a" });
    assert.ok(first.ok, first.errorText);
    const second = await mcp(p.mcpToken, "enable_plugin", { id: "cap_inbox_b" });
    assert.equal(second.ok, false);
    assert.match(second.errorText, /\[E_CONFLICT\]/, second.errorText);
    assert.match(second.errorText, /cap_inbox_a/, "names the current provider");
    assert.match(second.errorText, /swap:true/, "teaches the swap");
  });

  it("swap:true switches providers: old disabled, new enabled", async () => {
    const r = await mcp(p.mcpToken, "enable_plugin", { id: "cap_inbox_b", swap: true });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.swappedOut, ["cap_inbox_a"]);
    const list = await mcp(p.mcpToken, "list_plugins", {});
    const state = Object.fromEntries(list.value.map((x) => [x.id, x.enabled]));
    assert.equal(state.cap_inbox_b, true);
    assert.equal(state.cap_inbox_a, false);
  });

  it("requires: single catalog provider auto-enables with a note", async () => {
    const r = await mcp(p.mcpToken, "enable_plugin", { id: "needs_sched" });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.alsoEnabled, ["cap_sched"]);
    assert.match((r.value.notes ?? []).join(" "), /auto-enabled "cap_sched"/);
  });

  it("requires: already-satisfied capability does not re-enable or conflict", async () => {
    // test_inbox is provided by the ACTIVE cap_inbox_b — needs_inbox must ride it.
    const r = await mcp(p.mcpToken, "enable_plugin", { id: "needs_inbox" });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.alsoEnabled, undefined, JSON.stringify(r.value));
  });

  it("requires: no provider in the catalog is a clear error", async () => {
    const r = await mcp(p.mcpToken, "enable_plugin", { id: "needs_ghost" });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /test_ghost/, r.errorText);
    assert.match(r.errorText, /no plugin.*provides/i, r.errorText);
  });

  it("requires: ambiguous providers ask the caller to choose", async () => {
    // Disable both inbox providers, then a requires:test_inbox faces two catalog candidates.
    await mcp(p.mcpToken, "disable_plugin", { id: "cap_inbox_b" });
    await mcp(p.mcpToken, "disable_plugin", { id: "needs_inbox" });
    const r = await mcp(p.mcpToken, "enable_plugin", { id: "needs_inbox" });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /cap_inbox_a/, r.errorText);
    assert.match(r.errorText, /cap_inbox_b/, r.errorText);
    assert.match(r.errorText, /enable ONE/i, r.errorText);
  });

  it("legacy defs without provides compose freely", async () => {
    const r = await mcp(p.mcpToken, "enable_plugin", { id: "legacy_free" });
    assert.ok(r.ok, r.errorText);
  });

  it("disable warns when a dependent loses its provider", async () => {
    await mcp(p.mcpToken, "enable_plugin", { id: "cap_inbox_a" });
    const dep = await mcp(p.mcpToken, "enable_plugin", { id: "needs_inbox" });
    assert.ok(dep.ok, dep.errorText);
    const r = await mcp(p.mcpToken, "disable_plugin", { id: "cap_inbox_a" });
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.warning ?? "", /needs_inbox/, JSON.stringify(r.value));
    assert.match(r.value.warning ?? "", /test_inbox/);
  });

  it("GRANDFATHER: pre-existing double-providers stay enabled and functional", async () => {
    // Model the CSLP shape: two providers of the same capability enabled
    // directly in the DB (as if enabled before enforcement existed) — the
    // enable path and its rule are entirely bypassed, like history was.
    await sql`INSERT INTO project_plugins (project_id, plugin_id)
              VALUES (${p.id}, 'cap_inbox_a'), (${p.id}, 'cap_inbox_b')
              ON CONFLICT DO NOTHING`;
    const list = await mcp(p.mcpToken, "list_plugins", {});
    const state = Object.fromEntries(list.value.map((x) => [x.id, x.enabled]));
    assert.equal(state.cap_inbox_a, true, "grandfathered provider A stays");
    assert.equal(state.cap_inbox_b, true, "grandfathered provider B stays");
    // Enabling something UNRELATED must not disturb the grandfathered overlap.
    const unrelated = await mcp(p.mcpToken, "enable_plugin", { id: "cap_sched" });
    assert.ok(unrelated.ok, unrelated.errorText);
    const after = await mcp(p.mcpToken, "list_plugins", {});
    const s2 = Object.fromEntries(after.value.map((x) => [x.id, x.enabled]));
    assert.equal(s2.cap_inbox_a && s2.cap_inbox_b, true, "overlap untouched by unrelated enables");
  });

  it("list_plugins surfaces provides/requires; real catalog defs are annotated", async () => {
    const list = await mcp(p.mcpToken, "list_plugins", {});
    const auth = list.value.find((x) => x.id === "auth_kit");
    assert.deepEqual(auth?.provides, ["identity"]);
    const notify = list.value.find((x) => x.id === "notification_kit");
    assert.deepEqual(notify?.provides, ["notifications"]);
    const cf = list.value.find((x) => x.id === "contact_forms");
    assert.deepEqual(cf?.provides, ["lead_capture"]);
    const crm = list.value.find((x) => x.id === "countryside_crm");
    assert.deepEqual(crm?.provides, ["crm", "lead_capture", "booking"]);
  });
});
