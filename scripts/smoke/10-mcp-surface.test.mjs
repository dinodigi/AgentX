import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

describe("mcp surface: error codes", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("mcp-surface");
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "title", label: "Title", type: "text", required: true }],
    });
    assert.ok(def.ok, def.errorText);
  });
  after(() => p.destroy());

  it("not-found and unknown-tool errors carry stable codes", async () => {
    const missing = await mcp(p.mcpToken, "query_entries", { collection: "nope" });
    assert.ok(!missing.ok && /\[E_NOT_FOUND\]/.test(missing.errorText), missing.errorText);

    const entry = await mcp(p.mcpToken, "get_entry", {
      collection: "notes",
      id: "00000000-0000-0000-0000-000000000000",
    });
    assert.ok(!entry.ok && /\[E_NOT_FOUND\]/.test(entry.errorText), entry.errorText);

    const bogus = await mcp(p.mcpToken, "summon_dragon", {});
    assert.ok(!bogus.ok && /\[E_UNKNOWN_TOOL\]/.test(bogus.errorText), bogus.errorText);
  });

  it("validation errors carry E_VALIDATION with the fix hint intact", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      fields: [{ name: "x", label: "X", type: "geolocation" }],
    });
    assert.ok(!r.ok && /\[E_VALIDATION\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /Invalid enum value/); // hint text survives the code prefix

    const data = await mcp(p.mcpToken, "create_entry", { collection: "notes", data: {} });
    assert.ok(!data.ok && /\[E_VALIDATION\]/.test(data.errorText), data.errorText);
  });

  it("confirm plans carry E_CONFIRM_REQUIRED", async () => {
    await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { title: "t" } });
    const redefine = await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "body", label: "Body", type: "text" }],
    });
    assert.ok(redefine.ok && redefine.value.requiresConfirmation, redefine.errorText);
    assert.equal(redefine.value.code, "E_CONFIRM_REQUIRED");

    const del = await mcp(p.mcpToken, "delete_collection", { name: "notes" });
    assert.ok(del.ok && del.value.requiresConfirmation);
    assert.equal(del.value.code, "E_CONFIRM_REQUIRED");
  });

  it("blocked deletes carry E_BLOCKED", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "tags",
      fields: [{ name: "name", label: "Name", type: "text" }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "tag", label: "Tag", type: "relation", targetCollection: "tags", labelField: "name" },
      ],
    });
    const r = await mcp(p.mcpToken, "delete_collection", { name: "tags", confirm: true });
    assert.ok(!r.ok && /\[E_BLOCKED\]/.test(r.errorText), r.errorText);
  });

  it("email actions without Resend carry E_CONNECTOR_REQUIRED", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "rsvps",
      fields: [{ name: "email", label: "Email", type: "text" }],
      events: { created: [{ type: "email", to: "{{email}}", subject: "hi" }] },
    });
    assert.ok(!r.ok && /\[E_CONNECTOR_REQUIRED\]/.test(r.errorText), r.errorText);
  });

  it("scope rejection carries E_SCOPE; GET exposes the code registry", async () => {
    const r = await mcp(p.deliveryToken, "list_collections", {});
    assert.ok(!r.ok && /\[E_SCOPE\]/.test(r.errorText), r.errorText);

    const res = await fetch(`${BASE}/api/mcp`);
    const body = await res.json();
    assert.ok(body.errorCodes && body.errorCodes.E_VALIDATION, "registry missing from GET");
    assert.ok(Object.keys(body.errorCodes).every((k) => k.startsWith("E_")));
  });
});
