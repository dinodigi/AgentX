import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

// J3: project locale registry — set_locales round-trip, validation with fix
// hints, and the manifest carrying locales (applied before collections on
// import). The destructive confirm gate (removal/default-change with stored
// variants) is smoke-tested in the J5 suite, where localized fields exist to
// hold variants; here removal with zero variants must apply cleanly.

describe("locales config (J3)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("locales");
  });
  after(async () => {
    await p.destroy();
  });

  it("set_locales round-trips through get_project_info, normalized lowercase", async () => {
    const r = await mcp(p.mcpToken, "set_locales", {
      default: "EN",
      supported: ["EN", "de", "pt-BR"],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.locales, { default: "en", supported: ["en", "de", "pt-br"] });

    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(info.ok, info.errorText);
    assert.deepEqual(info.value.locales, { default: "en", supported: ["en", "de", "pt-br"] });
    assert.equal(info.value.localesHint, undefined, "hint only shown while unconfigured");
  });

  it("rejects a default outside supported, with a fix hint", async () => {
    const r = await mcp(p.mcpToken, "set_locales", { default: "fr", supported: ["en"] });
    assert.ok(!r.ok);
    assert.match(r.errorText, /E_VALIDATION/);
    assert.match(r.errorText, /add it to the supported list/);
  });

  it("rejects malformed locale tags", async () => {
    const r = await mcp(p.mcpToken, "set_locales", {
      default: "en",
      supported: ["en", "not a tag!"],
    });
    assert.ok(!r.ok);
    assert.match(r.errorText, /not a valid locale tag/);
  });

  it("removal + default change apply cleanly while no translations exist", async () => {
    const r = await mcp(p.mcpToken, "set_locales", { default: "de", supported: ["de"] });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.locales, { default: "de", supported: ["de"] });
    assert.equal(r.value.purgedVariants, undefined, "nothing to purge without variants");
  });

  it("export_project → import_project carries locales into a fresh project", async () => {
    const set = await mcp(p.mcpToken, "set_locales", { default: "en", supported: ["en", "de"] });
    assert.ok(set.ok, set.errorText);

    const exp = await mcp(p.mcpToken, "export_project", {});
    assert.ok(exp.ok, exp.errorText);
    assert.deepEqual(exp.value.project.locales, { default: "en", supported: ["en", "de"] });

    const p2 = await createEphemeralProject("locales-import");
    try {
      const imp = await mcp(p2.mcpToken, "import_project", { manifest: exp.value });
      assert.ok(imp.ok, imp.errorText);
      assert.equal(imp.value.code, undefined, "no confirm needed on a fresh project");

      const info = await mcp(p2.mcpToken, "get_project_info", {});
      assert.deepEqual(info.value.locales, { default: "en", supported: ["en", "de"] });
    } finally {
      await p2.destroy();
    }
  });

  it("a manifest without locales leaves existing locales untouched", async () => {
    const exp = await mcp(p.mcpToken, "export_project", {});
    assert.ok(exp.ok, exp.errorText);
    delete exp.value.project.locales;

    const imp = await mcp(p.mcpToken, "import_project", { manifest: exp.value });
    assert.ok(imp.ok, imp.errorText);

    const info = await mcp(p.mcpToken, "get_project_info", {});
    assert.deepEqual(info.value.locales, { default: "en", supported: ["en", "de"] });
  });

  it("a project without locales advertises the hint", async () => {
    const p3 = await createEphemeralProject("locales-hint");
    try {
      const info = await mcp(p3.mcpToken, "get_project_info", {});
      assert.ok(info.ok, info.errorText);
      assert.equal(info.value.locales, null);
      assert.match(info.value.localesHint, /set_locales/);
    } finally {
      await p3.destroy();
    }
  });
});
