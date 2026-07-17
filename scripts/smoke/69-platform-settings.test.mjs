import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, sql, collectionId } from "./helpers.mjs";

// Platform Settings: operator-edited caps live in platform_settings and the
// enforcement gates read them (effectiveCaps). Proven with a PERMISSIVE
// override — raise the sandbox entries cap 1000 → 1500, seed 1200 rows, and a
// create that the DEFAULT cap would refuse must succeed once the override
// propagates (settings cache TTL ≤60s; briefly-raised caps are harmless to
// other sandboxes on the shared control DB, unlike a restrictive test value).
describe("platform settings drive the caps (operator console)", () => {
  let p;

  before(async () => {
    await ensureServer();
    await sql`INSERT INTO platform_settings (key, value) VALUES ('caps.sandbox', '{"entries": 1500}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    p = await createEphemeralProject("platform-settings");
    await sql`UPDATE projects SET plan = 'sandbox' WHERE id = ${p.id}`; // before any cap check caches the plan
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "Title", type: "text", required: true, publicRead: true }],
    });
    assert.ok(def.ok, def.errorText);
    const cid = await collectionId(p.id, "posts");
    await sql`INSERT INTO entries (project_id, collection_id, data)
      SELECT ${p.id}, ${cid}, jsonb_build_object('title', 'seed ' || g) FROM generate_series(1, 1200) g`;
  });

  after(async () => {
    await sql`DELETE FROM platform_settings WHERE key = 'caps.sandbox'`;
    await p?.destroy();
  });

  it("a create the DEFAULT cap (1000) refuses succeeds under the override (1500)", async () => {
    // Poll: the server's settings cache converges within its 60s TTL.
    const deadline = Date.now() + 100_000;
    let last;
    for (;;) {
      last = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "over default" } });
      if (last.ok) break;
      assert.match(last.errorText, /cap reached: entries/i, `unexpected error: ${last.errorText}`);
      if (Date.now() > deadline) assert.fail(`override never took effect: ${last.errorText}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    assert.ok(last.ok);
  });
});
