import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  mcp,
  BASE,
  startWebhookReceiver,
  waitFor,
} from "./helpers.mjs";

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

  it("query_entries pages with hasMore/nextOffset until exhausted", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "items",
      fields: [{ name: "n", label: "N", type: "number" }],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "items",
      entries: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }],
    });

    const seen = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const r = await mcp(p.mcpToken, "query_entries", {
        collection: "items",
        limit: 2,
        offset,
        orderBy: { field: "n", dir: "asc" },
      });
      assert.ok(r.ok, r.errorText);
      seen.push(...r.value.entries.map((e) => e.data.n));
      pages++;
      if (!r.value.hasMore) {
        assert.equal(r.value.nextOffset, null);
        break;
      }
      assert.equal(r.value.nextOffset, offset + 2);
      offset = r.value.nextOffset;
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5]); // no overlaps, no gaps
    assert.equal(pages, 3);
  });

  it("list_assets returns the page envelope", async () => {
    const r = await mcp(p.mcpToken, "list_assets", { limit: 10 });
    assert.ok(r.ok, r.errorText);
    assert.ok(Array.isArray(r.value.assets));
    assert.equal(r.value.hasMore, false);
    assert.equal(r.value.nextOffset, null);
  });

  it("get_deliveries: agent reads its own webhook outcomes, filters work", async () => {
    const hook = await startWebhookReceiver();
    try {
      await mcp(p.mcpToken, "define_collection", {
        name: "signups",
        fields: [{ name: "email", label: "Email", type: "text" }],
        events: { created: [{ type: "webhook", url: hook.url }] },
      });
      const created = await mcp(p.mcpToken, "create_entry", {
        collection: "signups",
        data: { email: "a@b.c" },
      });
      assert.ok(created.ok, created.errorText);

      const logged = await waitFor(async () => {
        const r = await mcp(p.mcpToken, "get_deliveries", { collection: "signups" });
        return r.ok && r.value.deliveries.length > 0 ? r.value : null;
      });
      assert.ok(logged, "delivery never appeared in get_deliveries");
      const d = logged.deliveries[0];
      assert.equal(d.event, "entry.created");
      assert.equal(d.status, "success");
      assert.equal(d.url, hook.url);
      assert.equal(d.payload.entry.id, created.value.id);
      assert.equal(logged.hasMore, false);

      const failed = await mcp(p.mcpToken, "get_deliveries", {
        collection: "signups",
        status: "failed",
      });
      assert.equal(failed.value.deliveries.length, 0);

      const badCollection = await mcp(p.mcpToken, "get_deliveries", { collection: "nope" });
      assert.ok(!badCollection.ok && /\[E_NOT_FOUND\]/.test(badCollection.errorText));
    } finally {
      await hook.close();
    }
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
