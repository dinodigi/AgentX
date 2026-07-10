import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// J8: toggling localized on POPULATED fields. Localize ON = atomic wrap of
// existing strings under the default locale (non-destructive, immediate).
// Delocalize = counted plan + confirm; keeps the default variant, drops the
// rest, and entries WITHOUT a default variant lose the field entirely (a text
// field must never hold JSON null).

const FIELDS_PLAIN = [
  { name: "title", label: "Title", type: "text", publicRead: true },
  { name: "note", label: "Note", type: "text", publicRead: true },
];
const FIELDS_LOCALIZED = [
  { name: "title", label: "Title", type: "text", localized: true, publicRead: true },
  { name: "note", label: "Note", type: "text", publicRead: true },
];

describe("localized backfill toggles (J8)", () => {
  let p, id;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("localized-backfill");
    const set = await mcp(p.mcpToken, "set_locales", { default: "en", supported: ["en", "de"] });
    assert.ok(set.ok, set.errorText);
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      displayName: "Docs",
      fields: FIELDS_PLAIN,
    });
    assert.ok(def.ok, def.errorText);
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "docs",
      data: { title: "Plain Title", note: "keep me" },
    });
    assert.ok(c.ok, c.errorText);
    id = c.value.id;
  });
  after(async () => {
    await p.destroy();
  });

  it("localizing a populated field wraps values under the default locale", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      displayName: "Docs",
      fields: FIELDS_LOCALIZED,
    });
    assert.ok(r.ok, r.errorText);
    assert.ok(
      r.value.changes?.localized?.some((l) => l.field === "title" && l.entriesToWrap === 1),
      `wrap reported: ${JSON.stringify(r.value.changes)}`,
    );

    const got = await mcp(p.mcpToken, "get_entry", { collection: "docs", id });
    assert.deepEqual(got.value.data.title, { en: "Plain Title" }, "value wrapped, not lost");
    assert.equal(got.value.data.note, "keep me", "untouched sibling stays plain");

    // The wrapped map behaves like any localized field from here on.
    const up = await mcp(p.mcpToken, "update_entry", {
      collection: "docs",
      id,
      data: { title: { de: "Deutscher Titel" } },
    });
    assert.ok(up.ok, up.errorText);
    const flat = await delivery(p.deliveryToken, `/docs/${id}?locale=de`);
    assert.equal(flat.json.data.title, "Deutscher Titel");
  });

  it("delocalizing returns a counted plan naming the variants lost", async () => {
    // A second entry with both variants — the plan counts it and names "de".
    const extra = await mcp(p.mcpToken, "create_entry", {
      collection: "docs",
      data: { title: { en: "temp", de: "nur deutsch" } },
    });
    assert.ok(extra.ok, extra.errorText);
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      displayName: "Docs",
      fields: FIELDS_PLAIN,
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.requiresConfirmation, true);
    assert.equal(r.value.code, "E_CONFIRM_REQUIRED");
    const d = r.value.plan.delocalized.find((x) => x.field === "title");
    assert.ok(d, JSON.stringify(r.value.plan));
    assert.equal(d.entriesAffected, 2);
    assert.deepEqual(d.variantsLost, ["de"]);
    assert.match(r.value.hint, /delocalizing drops every non-default variant/);
  });

  it("confirmed delocalize keeps the default variant as the plain value", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      displayName: "Docs",
      fields: FIELDS_PLAIN,
      confirm: true,
    });
    assert.ok(r.ok, r.errorText);

    const got = await mcp(p.mcpToken, "get_entry", { collection: "docs", id });
    assert.equal(got.value.data.title, "Plain Title", "default variant kept as plain string");

    // Field behaves plain again: filters work, plain writes validate.
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "docs",
      where: [{ field: "title", op: "eq", value: "Plain Title" }],
    });
    assert.ok(q.ok, q.errorText);
    assert.equal(q.value.entries.length, 1);
  });

  it("delocalize drops the field on entries lacking a default variant", async () => {
    // Localize again, then hand-craft a default-less variant map via the
    // MERGE path being unavailable — use bulk create with de-only (title is
    // optional on docs, so a de-only map is writable? No: J5 requires nothing
    // for optional fields, and the map itself only needs valid locales).
    const loc = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      displayName: "Docs",
      fields: FIELDS_LOCALIZED,
      confirm: true,
    });
    assert.ok(loc.ok, loc.errorText);
    const deOnly = await mcp(p.mcpToken, "create_entry", {
      collection: "docs",
      data: { title: { de: "ohne default" }, note: "loses title" },
    });
    assert.ok(deOnly.ok, deOnly.errorText);

    const plan = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      displayName: "Docs",
      fields: FIELDS_PLAIN,
    });
    assert.equal(plan.value.requiresConfirmation, true);
    const d = plan.value.plan.delocalized.find((x) => x.field === "title");
    assert.equal(d.entriesLosingField, 1, JSON.stringify(d));

    const r = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      displayName: "Docs",
      fields: FIELDS_PLAIN,
      confirm: true,
    });
    assert.ok(r.ok, r.errorText);
    const got = await mcp(p.mcpToken, "get_entry", { collection: "docs", id: deOnly.value.id });
    assert.equal(got.value.data.title, undefined, "default-less entry loses the field (never JSON null)");
    assert.equal(got.value.data.note, "loses title", "siblings untouched");
  });

  it("localizing a field that is an inbound labelField stays rejected", async () => {
    const refs = await mcp(p.mcpToken, "define_collection", {
      name: "refs",
      displayName: "Refs",
      fields: [
        { name: "doc", label: "Doc", type: "relation", targetCollection: "docs", labelField: "note", publicRead: true },
      ],
    });
    assert.ok(refs.ok, refs.errorText);

    const r = await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      displayName: "Docs",
      fields: [
        FIELDS_PLAIN[0],
        { name: "note", label: "Note", type: "text", localized: true, publicRead: true },
      ],
      confirm: true,
    });
    assert.ok(!r.ok, "cross-collection labelField guard holds on the toggle path");
    assert.match(r.errorText, /labelField of inbound relation/);
    assert.match(r.errorText, /refs\.doc/);
  });
});
