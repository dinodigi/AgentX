import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery, sql } from "./helpers.mjs";
import { COUNTRYSIDE_PLUGIN } from "../../plugins/countryside-crm.mjs";

// Track 6 (DB-backed catalog) + the Countryside client plugin, end to end:
// project-scoped authoring isolation, global seeding, and the REAL proof —
// applying the full baseline (workflow + computed-unique + write gates) and
// exercising every acceptance criterion.
describe("DB plugin catalog + Countryside CRM plugin", () => {
  let p, other;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("countryside");
    other = await createEphemeralProject("catalog-isolation");
    // Seed the Countryside def GLOBAL (what the seed script does).
    await sql`
      INSERT INTO plugin_defs (id, project_id, definition, updated_at)
      VALUES (${COUNTRYSIDE_PLUGIN.id}, NULL, ${JSON.stringify(COUNTRYSIDE_PLUGIN)}::jsonb, now())
      ON CONFLICT (id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()`;
  });

  it("define_plugin authors PROJECT-SCOPED defs — invisible to other projects", async () => {
    const def = {
      id: "private_test_plugin",
      version: "0.1.0",
      name: "Private",
      description: "project-scoped only",
      guidance: "nothing",
    };
    const r = await mcp(p.mcpToken, "define_plugin", { definition: def });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.scope, "this project only");
    const mine = await mcp(p.mcpToken, "list_plugins", {});
    assert.ok(mine.value.some((x) => x.id === "private_test_plugin"), "author sees it");
    const theirs = await mcp(other.mcpToken, "list_plugins", {});
    assert.ok(!theirs.value.some((x) => x.id === "private_test_plugin"), "other project must NOT see it");
    const bad = await mcp(p.mcpToken, "define_plugin", { definition: { ...def, id: "seo" } });
    assert.equal(bad.ok, false, "built-in ids are reserved");
  });

  it("the GLOBAL Countryside def is visible + enable/get work through the DB path", async () => {
    const list = await mcp(p.mcpToken, "list_plugins", {});
    const c = list.value.find((x) => x.id === "countryside_crm");
    assert.ok(c, "global DB def in the catalog");
    const e = await mcp(p.mcpToken, "enable_plugin", { id: "countryside_crm" });
    assert.ok(e.ok, e.errorText);
    const g = await mcp(p.mcpToken, "get_plugin", { id: "countryside_crm" });
    assert.ok(g.ok, g.errorText);
    assert.equal(g.value.enabled, true);
    assert.equal(g.value.structure.baseline.length, 6); // + reps (v1.1)
  });

  it("APPLY: the full baseline defines cleanly (workflow + computed-unique included)", async () => {
    for (const c of COUNTRYSIDE_PLUGIN.structure.baseline) {
      const r = await mcp(p.mcpToken, "define_collection", {
        name: c.name,
        displayName: c.displayName,
        ...(c.publicWrite ? { publicWrite: c.publicWrite } : {}),
        fields: c.fields,
        ...(c.workflow ? { workflow: c.workflow } : {}),
      });
      assert.ok(r.ok, `${c.name}: ${r.errorText}`);
    }
  });

  it("lifecycle: initial status enforced; KIT ladder + the unprotected re-entry work", async () => {
    const ranch = await mcp(p.mcpToken, "create_entry", {
      collection: "ranches",
      data: { code: "SPR", name: "Sandy Point Ranch" },
    });
    assert.ok(ranch.ok, ranch.errorText);
    const lead = await mcp(p.mcpToken, "create_entry", {
      collection: "leads",
      data: { name: "Buyer One", email: "b1@example.com", ranch_code: "SPR", source: "web" },
    });
    assert.ok(lead.ok, lead.errorText);
    const id = lead.value.id;
    const created = await mcp(p.mcpToken, "get_entry", { collection: "leads", id });
    assert.equal((created.value.data ?? created.value).status, "new", "workflow initial state");

    for (const to of ["left_message", "kit", "unprotected", "new"]) {
      const t = await mcp(p.mcpToken, "update_entry", { collection: "leads", id, data: { status: to } });
      assert.ok(t.ok, `→${to}: ${t.errorText}`);
    }
    const skip = await mcp(p.mcpToken, "update_entry", { collection: "leads", id, data: { status: "converted" } });
    assert.equal(skip.ok, false, "new→converted must be an illegal transition");
  });

  it("web POST can submit a lead but CANNOT set owner/status/rating (403)", async () => {
    const okPost = await delivery(p.deliveryToken, "/leads", {
      method: "POST",
      body: { name: "Web Buyer", email: "w@example.com", ranch_code: "SPR", source: "web", honeypot: "" },
    });
    assert.equal(okPost.status, 201, JSON.stringify(okPost.json));
    const forged = await delivery(p.deliveryToken, "/leads", {
      method: "POST",
      body: { name: "Evil", owner: "me", status: "converted" },
    });
    assert.equal(forged.status, 403, JSON.stringify(forged.json));
  });

  it("no-double-book: same rep+date+slot rejected by the unique slot_key", async () => {
    const lead = await mcp(p.mcpToken, "query_entries", { collection: "leads", limit: 1 });
    const leadId = (lead.value.entries ?? lead.value)[0].id;
    const mk = () =>
      mcp(p.mcpToken, "create_entry", {
        collection: "appointments",
        data: { lead: leadId, rep: "Dana", tour_date: "2026-08-01", slot: "slot_1pm", status: "made" },
      });
    const first = await mk();
    assert.ok(first.ok, first.errorText);
    const dupe = await mk();
    assert.equal(dupe.ok, false, "double-book must be rejected");
    assert.match(dupe.errorText, /slot_key|unique/i, dupe.errorText);
    const otherSlot = await mcp(p.mcpToken, "create_entry", {
      collection: "appointments",
      data: { lead: leadId, rep: "Dana", tour_date: "2026-08-01", slot: "slot_3pm", status: "made" },
    });
    assert.ok(otherSlot.ok, "different slot books fine");
  });

  it("the unprotected queue = owner exists:false, and owner is a rep RELATION", async () => {
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ field: "owner", op: "exists", value: false }],
    });
    assert.ok(q.ok, q.errorText);
    const rows = q.value.entries ?? q.value;
    assert.ok(rows.length >= 2, "both ownerless leads surface");
    // A rep is a real entry now — protect by its id (relation), not a string.
    const rep = await mcp(p.mcpToken, "create_entry", { collection: "reps", data: { name: "Dana", active: true } });
    assert.ok(rep.ok, rep.errorText);
    const id = rows[0].id;
    const assign = await mcp(p.mcpToken, "update_entry", { collection: "leads", id, data: { owner: rep.value.id } });
    assert.ok(assign.ok, assign.errorText);
    const after = await mcp(p.mcpToken, "query_entries", {
      collection: "leads",
      where: [{ field: "owner", op: "exists", value: false }],
    });
    assert.ok(!(after.value.entries ?? after.value).some((r) => r.id === id), "protected lead left the queue");
  });

  it("leads-by-rep report runs (groupBy owner) — the v1.1 defect fix", async () => {
    // The recipe the plugin's own guidance advertises; impossible when owner
    // was text (aggregate groupBy needs enum/relation).
    const r = await mcp(p.mcpToken, "aggregate_entries", {
      collection: "leads",
      groupBy: "owner",
      aggregates: [{ fn: "count" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.ok(Array.isArray(r.value.groups), JSON.stringify(r.value));
  });
});
