import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ensureServer, createEphemeralProject, mcp, delivery, sql } from "./helpers.mjs";
import { BOOKING_PLUGIN } from "../../plugins/booking.mjs";
import { WAITLIST_PLUGIN } from "../../plugins/waitlist.mjs";
import { FEEDBACK_WALL_PLUGIN } from "../../plugins/feedback-wall.mjs";
import { MEDIA_GALLERY_PLUGIN } from "../../plugins/media-gallery.mjs";

// Plugin Bases Plan, Track D — the wave-1 bases: distinct capabilities that
// enable TOGETHER without conflict (the poke-project shape), each proving its
// core acceptance invariants.
const BASES = [BOOKING_PLUGIN, WAITLIST_PLUGIN, FEEDBACK_WALL_PLUGIN, MEDIA_GALLERY_PLUGIN];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("wave-1 bases (booking, waitlist, feedback_wall, media_gallery)", () => {
  let p, srv, base;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("wave1");
    for (const def of BASES) {
      await sql`
        INSERT INTO plugin_defs (id, project_id, definition, updated_at)
        VALUES (${def.id}, NULL, ${JSON.stringify(def)}::jsonb, now())
        ON CONFLICT (id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
        DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()`;
    }
    srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
      res.end(PNG);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(async () => {
    srv.close();
    await p.destroy();
  });

  it("all four enable together — distinct capabilities, zero conflicts (the poke shape)", async () => {
    for (const def of BASES) {
      const r = await mcp(p.mcpToken, "enable_plugin", { id: def.id });
      assert.ok(r.ok, `${def.id}: ${r.errorText}`);
    }
    const list = await mcp(p.mcpToken, "list_plugins", {});
    for (const def of BASES) {
      const row = list.value.find((x) => x.id === def.id);
      assert.equal(row?.enabled, true, def.id);
      assert.deepEqual(row?.provides, [def.provides], def.id);
    }
  });

  it("APPLY: every baseline defines cleanly", async () => {
    for (const def of BASES) {
      for (const c of def.structure.baseline) {
        const r = await mcp(p.mcpToken, "define_collection", {
          name: c.name,
          displayName: c.displayName,
          ...(c.publicWrite ? { publicWrite: true } : {}),
          ...(c.publicFilter ? { publicFilter: c.publicFilter } : {}),
          fields: c.fields,
          ...(c.workflow ? { workflow: c.workflow } : {}),
        });
        assert.ok(r.ok, `${def.id}/${c.name}: ${r.errorText}`);
      }
    }
  });

  it("booking: no-double-book holds; confirm path works", async () => {
    const res = await mcp(p.mcpToken, "create_entry", {
      collection: "booking_resources",
      data: { name: "Table 5", active: true },
    });
    assert.ok(res.ok, res.errorText);
    const mk = () =>
      mcp(p.mcpToken, "create_entry", {
        collection: "bookings",
        data: { resource: res.value.id, booking_date: "2026-08-01", slot: "19:00", booked_for: "Ada", held_at: new Date().toISOString() },
      });
    const b1 = await mk();
    assert.ok(b1.ok, b1.errorText);
    assert.equal(b1.value.data.status, "held");
    const b2 = await mk();
    assert.equal(b2.ok, false, "double-book must be rejected");
    assert.match(b2.errorText, /slot_key|unique/i, b2.errorText);
    const confirm = await mcp(p.mcpToken, "update_entry", {
      collection: "bookings", id: b1.value.id, data: { status: "confirmed" },
    });
    assert.ok(confirm.ok, confirm.errorText);
  });

  it("waitlist: anonymous signup lands; dupes reject; server fields locked; uuid stamped", async () => {
    const anon = await delivery(p.deliveryToken, "/waitlist_signups", {
      method: "POST",
      body: { email: "fan@example.com", name: "Fan", source: "footer" },
    });
    assert.equal(anon.status, 201, JSON.stringify(anon.json));
    const dup = await delivery(p.deliveryToken, "/waitlist_signups", {
      method: "POST",
      body: { email: "fan@example.com" },
    });
    assert.notEqual(dup.status, 201, "duplicate email must not create");
    const sneak = await delivery(p.deliveryToken, "/waitlist_signups", {
      method: "POST",
      body: { email: "sneak@example.com", status: "invited" },
    });
    assert.equal(sneak.status, 403, "status is server-owned");
    const row = (await mcp(p.mcpToken, "query_entries", {
      collection: "waitlist_signups",
      where: [{ field: "email", op: "eq", value: "fan@example.com" }],
    })).value.entries[0];
    assert.equal(row.data.status, "waiting");
    assert.match(row.data.invite_code, /^[0-9a-f-]{36}$/i, "uuid invite code stamped");
  });

  it("feedback_wall: anonymous intake as new; status locked; groupBy reports run", async () => {
    for (const [summary, category] of [["TEST love it", "praise"], ["TEST broken thing", "bug"], ["TEST another bug", "bug"]]) {
      const r = await delivery(p.deliveryToken, "/feedback_items", {
        method: "POST",
        body: { summary, category, page_url: "https://site/x" },
      });
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    const sneak = await delivery(p.deliveryToken, "/feedback_items", {
      method: "POST",
      body: { summary: "TEST sneak", category: "bug", status: "done" },
    });
    assert.equal(sneak.status, 403, "status is server-owned");
    const agg = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "feedback_items",
      aggregates: [{ fn: "count" }],
      groupBy: "category",
    });
    assert.ok(agg.ok, agg.errorText);
    assert.match(JSON.stringify(agg.value), /bug/, "category buckets aggregate");
  });

  it("media_gallery: url-seeded images; publish gating on delivery", async () => {
    const up1 = await mcp(p.mcpToken, "upload_asset", { filename: "a.png", url: `${base}/a.png` });
    const up2 = await mcp(p.mcpToken, "upload_asset", { filename: "b.png", url: `${base}/b.png` });
    assert.ok(up1.ok && up2.ok, up1.errorText ?? up2.errorText);
    const g = await mcp(p.mcpToken, "create_entry", {
      collection: "galleries",
      data: { title: "Summer Nights", description: "venue shots", cover: up1.value.id, images: [up1.value.id, up2.value.id], published: false },
    });
    assert.ok(g.ok, g.errorText);
    assert.equal(g.value.data.slug, "summer-nights", "slug computed");

    const hidden = await delivery(p.deliveryToken, "/galleries");
    assert.equal(hidden.status, 200);
    assert.equal((hidden.json.data ?? []).length, 0, "unpublished gallery is invisible");

    const pub = await mcp(p.mcpToken, "update_entry", {
      collection: "galleries", id: g.value.id, data: { published: true },
    });
    assert.ok(pub.ok, pub.errorText);
    const visible = await delivery(p.deliveryToken, "/galleries");
    assert.equal((visible.json.data ?? []).length, 1, "published gallery serves");
    assert.equal(visible.json.data[0].title, "Summer Nights");
    assert.ok(Array.isArray(visible.json.data[0].images), "image array serves publicly");
  });
});
