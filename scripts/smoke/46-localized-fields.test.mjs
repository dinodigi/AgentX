import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// J5: localized:true goes live — variant-map validation through the single
// validate() choke point, merge-on-update, define-time escape-channel guards,
// expand/include flattening, and the J3-deferred set_locales confirm gate
// (testable now that variants can exist).

describe("localized fields (J5)", () => {
  let p, noteId, articleId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("localized-fields");
    const set = await mcp(p.mcpToken, "set_locales", { default: "en", supported: ["en", "de"] });
    assert.ok(set.ok, set.errorText);

    const notes = await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      displayName: "Notes",
      fields: [
        { name: "label", label: "Label", type: "text", publicRead: true },
        { name: "content", label: "Content", type: "text", localized: true, publicRead: true },
      ],
    });
    assert.ok(notes.ok, notes.errorText);

    const articles = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      displayName: "Articles",
      fields: [
        { name: "title", label: "Title", type: "text", localized: true, required: true, publicRead: true },
        { name: "body", label: "Body", type: "richtext", localized: true, publicRead: true },
        { name: "tag", label: "Tag", type: "text", publicRead: true },
        { name: "note", label: "Note", type: "relation", targetCollection: "notes", labelField: "label", publicRead: true },
      ],
    });
    assert.ok(articles.ok, articles.errorText);
  });
  after(async () => {
    await p.destroy();
  });

  it("localized without set_locales is rejected with the fix named", async () => {
    const p2 = await createEphemeralProject("no-locales");
    try {
      const r = await mcp(p2.mcpToken, "define_collection", {
        name: "posts",
        displayName: "Posts",
        fields: [{ name: "t", label: "T", type: "text", localized: true }],
      });
      assert.ok(!r.ok);
      assert.match(r.errorText, /call set_locales/);
    } finally {
      await p2.destroy();
    }
  });

  it("meta-schema bars: wrong type, unique, searchable, computed-from-localized", async () => {
    const cases = [
      [{ name: "n", label: "N", type: "number", localized: true }, /only valid on text\/richtext/],
      [{ name: "t", label: "T", type: "text", localized: true, unique: true, max: 50 }, /cannot be unique/],
      [{ name: "t", label: "T", type: "text", localized: true, searchable: true }, /cannot be searchable/],
      [
        [
          { name: "t", label: "T", type: "text", localized: true },
          { name: "slug", label: "Slug", type: "text", computed: { fn: "slugify", from: "t" } },
        ],
        /references localized field/,
      ],
    ];
    for (const [fields, re] of cases) {
      const r = await mcp(p.mcpToken, "define_collection", {
        name: "bad",
        displayName: "Bad",
        fields: Array.isArray(fields) ? fields : [fields],
      });
      assert.ok(!r.ok, `expected rejection: ${re}`);
      assert.match(r.errorText, re);
    }
  });

  it("a relation may not point at a localized labelField", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "refs",
      displayName: "Refs",
      fields: [
        { name: "note", label: "Note", type: "relation", targetCollection: "notes", labelField: "content" },
      ],
    });
    assert.ok(!r.ok);
    assert.match(r.errorText, /localized.*labelField|labelField.*localized/i);
  });

  it("a field that is an inbound labelField cannot become localized", async () => {
    // articles.note uses notes.label as labelField — localizing notes.label must name it.
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      displayName: "Notes",
      fields: [
        { name: "label", label: "Label", type: "text", localized: true, publicRead: true },
        { name: "content", label: "Content", type: "text", localized: true, publicRead: true },
      ],
    });
    assert.ok(!r.ok);
    assert.match(r.errorText, /labelField of inbound relation/);
    assert.match(r.errorText, /articles\.note/);
  });

  it("email templates may not reference localized fields", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "articles2",
      displayName: "Articles2",
      fields: [{ name: "title", label: "Title", type: "text", localized: true }],
      events: { created: [{ type: "email", to: "x@y.z", subject: "New: {{title}}" }] },
    });
    assert.ok(!r.ok);
    assert.match(r.errorText, /references localized field/);
  });

  it("create validates variant maps strictly", async () => {
    const plain = await mcp(p.mcpToken, "create_entry", {
      collection: "articles",
      data: { title: "just a string" },
    });
    assert.ok(!plain.ok, "plain string rejected — localized expects a map");

    const unknown = await mcp(p.mcpToken, "create_entry", {
      collection: "articles",
      data: { title: { fr: "Bonjour" } },
    });
    assert.ok(!unknown.ok);
    assert.match(unknown.errorText, /unknown locale "fr"/);
    assert.match(unknown.errorText, /en, de/);

    const missingDefault = await mcp(p.mcpToken, "create_entry", {
      collection: "articles",
      data: { title: { de: "Hallo" } },
    });
    assert.ok(!missingDefault.ok, "required localized needs the default variant");
    assert.match(missingDefault.errorText, /default locale "en"/);

    const ok = await mcp(p.mcpToken, "create_entry", {
      collection: "articles",
      data: { title: { en: "Hello" }, body: { en: "<p>hi</p>", de: "<p>hallo</p>" }, tag: "news" },
    });
    assert.ok(ok.ok, ok.errorText);
    articleId = ok.value.id;
  });

  it("update MERGES variant maps; null unsets the whole field", async () => {
    const up = await mcp(p.mcpToken, "update_entry", {
      collection: "articles",
      id: articleId,
      data: { title: { de: "Hallo" } },
    });
    assert.ok(up.ok, up.errorText);

    const got = await mcp(p.mcpToken, "get_entry", { collection: "articles", id: articleId });
    assert.deepEqual(got.value.data.title, { en: "Hello", de: "Hallo" }, "en preserved by the merge");

    const unset = await mcp(p.mcpToken, "update_entry", {
      collection: "articles",
      id: articleId,
      data: { body: null },
    });
    assert.ok(unset.ok, unset.errorText);
    const got2 = await mcp(p.mcpToken, "get_entry", { collection: "articles", id: articleId });
    assert.equal(got2.value.data.body, undefined, "null unsets the whole variant map");
  });

  it("update_entry_if rejects localized fields with the alternative named", async () => {
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "articles",
      id: articleId,
      data: { title: { en: "X" } },
    });
    assert.ok(!r.ok);
    assert.match(r.errorText, /use update_entry/);
  });

  it("bulk create validates variant maps per item", async () => {
    const r = await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "articles",
      entries: [
        { title: { en: "Bulk A" } },
        { title: { xx: "bad locale" } },
      ],
    });
    assert.ok(r.ok, r.errorText);
    const items = r.value.results;
    assert.equal(items.find((i) => i.index === 0).ok, true);
    assert.equal(items.find((i) => i.index === 1).ok, false);
  });

  it("delivery ?expand= and ?include= flatten localized target fields", async () => {
    const note = await mcp(p.mcpToken, "create_entry", {
      collection: "notes",
      data: { label: "note-1", content: { en: "N-en", de: "N-de" } },
    });
    assert.ok(note.ok, note.errorText);
    noteId = note.value.id;
    const upd = await mcp(p.mcpToken, "update_entry", {
      collection: "articles",
      id: articleId,
      data: { note: noteId },
    });
    assert.ok(upd.ok, upd.errorText);

    const list = await delivery(p.deliveryToken, "/articles?expand=note");
    assert.equal(list.status, 200);
    const art = list.json.data.find((e) => e.id === articleId);
    assert.equal(art.note.data.content, "N-en", "expanded target's localized field is FLAT");
    assert.equal(art.title, "Hello", "own localized field flat too");

    const single = await delivery(p.deliveryToken, `/notes/${noteId}?include=articles.note`);
    assert.equal(single.status, 200);
    const kids = single.json.data.related["articles.note"];
    assert.ok(Array.isArray(kids?.entries), "children present");
    assert.equal(kids.entries[0].title, "Hello", "included child's localized field is FLAT");
    assert.ok(!JSON.stringify(single.json).includes("[object Object]"));
  });

  it("removing a locale with stored variants returns a counted plan (J3 gate)", async () => {
    const r = await mcp(p.mcpToken, "set_locales", { default: "en", supported: ["en"] });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.requiresConfirmation, true);
    assert.equal(r.value.code, "E_CONFIRM_REQUIRED");
    const lost = r.value.plan.variantsLost;
    assert.ok(lost.some((v) => v.collection === "articles" && v.field === "title" && v.locale === "de" && v.entries >= 1), JSON.stringify(lost));
  });

  it("changing the default with entries missing that variant returns a plan", async () => {
    const extra = await mcp(p.mcpToken, "create_entry", {
      collection: "articles",
      data: { title: { en: "en-only" } },
    });
    assert.ok(extra.ok, extra.errorText);

    const r = await mcp(p.mcpToken, "set_locales", { default: "de", supported: ["en", "de"] });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.requiresConfirmation, true);
    const missing = r.value.plan.entriesMissingNewDefault;
    assert.ok(missing.some((m) => m.collection === "articles" && m.field === "title" && m.entries >= 1), JSON.stringify(missing));
  });

  it("confirmed removal purges the dropped variants from stored entries", async () => {
    const r = await mcp(p.mcpToken, "set_locales", { default: "en", supported: ["en"], confirm: true });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.ok, true);
    assert.ok(r.value.purgedVariants.length >= 1, "purge reported");

    const got = await mcp(p.mcpToken, "get_entry", { collection: "articles", id: articleId });
    assert.deepEqual(got.value.data.title, { en: "Hello" }, "de variant purged from storage");
  });
});
