import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// J4: read-side localization plumbing, verified while the WRITE side is still
// gated (localized:true is rejected at define time). Variant maps are seeded
// via raw SQL — exactly the shape J5 will store — and the read paths must
// already serve flat default-locale strings, never "[object Object]".
const sql = neon(process.env.DATABASE_URL);

describe("localized read-side plumbing (J4)", () => {
  let p, e1, e2;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("localized-readside");

    const set = await mcp(p.mcpToken, "set_locales", { default: "en", supported: ["en", "de"] });
    assert.ok(set.ok, set.errorText);

    const def = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      displayName: "Posts",
      fields: [
        { name: "title", label: "Title", type: "text", publicRead: true },
        { name: "blurb", label: "Blurb", type: "text", publicRead: true },
        { name: "note", label: "Note", type: "text" }, // stays private
        { name: "slug", label: "Slug", type: "text", publicRead: true },
      ],
    });
    assert.ok(def.ok, def.errorText);

    const c1 = await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: { title: "placeholder", slug: "variant-map" },
    });
    assert.ok(c1.ok, c1.errorText);
    e1 = c1.value.id;
    const c2 = await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: { title: "plain pre-localize string", slug: "plain" },
    });
    assert.ok(c2.ok, c2.errorText);
    e2 = c2.value.id;

    // Flip title/blurb/note to localized + seed variant maps — raw SQL, the
    // write side lands in J5. blurb has NO en variant (key must be omitted).
    const [col] = await sql`SELECT id, fields FROM collections
      WHERE project_id = ${p.id} AND name = 'posts'`;
    const fields = col.fields.map((f) =>
      ["title", "blurb", "note"].includes(f.name) ? { ...f, localized: true } : f,
    );
    await sql`UPDATE collections SET fields = ${JSON.stringify(fields)}::jsonb WHERE id = ${col.id}`;
    await sql`UPDATE entries SET data = ${JSON.stringify({
      title: { en: "Hello", de: "Hallo" },
      blurb: { de: "nur deutsch" },
      note: { en: "private note" },
      slug: "variant-map",
    })}::jsonb WHERE id = ${e1}`;

    // getCollection is tag-cached; any define in the project revalidates the
    // project's collections tag, so the SQL flip becomes visible.
    const bust = await mcp(p.mcpToken, "define_collection", {
      name: "cachebust",
      displayName: "Cache Bust",
      fields: [{ name: "x", label: "X", type: "text" }],
    });
    assert.ok(bust.ok, bust.errorText);
  });
  after(async () => {
    await p.destroy();
  });

  it("define_collection still rejects localized:true (write side is J5)", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "articles",
      displayName: "Articles",
      fields: [{ name: "t", label: "T", type: "text", localized: true }],
    });
    assert.ok(!r.ok);
    assert.match(r.errorText, /localized fields are not yet enabled/);
  });

  it("delivery list GET serves flat default-locale strings", async () => {
    const r = await delivery(p.deliveryToken, "/posts");
    assert.equal(r.status, 200);
    const dump = JSON.stringify(r.json);
    assert.ok(!dump.includes("[object Object]"), "no stringified maps anywhere");
    const byId = Object.fromEntries(r.json.data.map((e) => [e.id, e]));
    assert.equal(byId[e1].title, "Hello", "default-locale variant served flat");
    assert.equal(byId[e1].blurb, undefined, "no default variant → key omitted");
    assert.equal(byId[e1].note, undefined, "private field never appears");
    assert.equal(byId[e2].title, "plain pre-localize string", "plain strings pass through");
  });

  it("delivery single GET matches the list shape", async () => {
    const r = await delivery(p.deliveryToken, `/posts/${e1}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.title, "Hello");
    assert.equal(r.json.data.blurb, undefined);
    assert.equal(r.json.data.slug, "variant-map");
  });

  it("MCP reads return the RAW variant map (agents manage translations)", async () => {
    const r = await mcp(p.mcpToken, "get_entry", { collection: "posts", id: e1 });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.data.title, { en: "Hello", de: "Hallo" });
    assert.deepEqual(r.value.data.blurb, { de: "nur deutsch" });
  });

  it("MCP where/orderBy on a localized field is rejected with a hint", async () => {
    const w = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "title", op: "eq", value: "Hello" }],
    });
    assert.ok(!w.ok);
    assert.match(w.errorText, /localized fields cannot be filtered or sorted/);

    const o = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      orderBy: { field: "title", dir: "asc" },
    });
    assert.ok(!o.ok);
    assert.match(o.errorText, /localized fields cannot be filtered or sorted/);
  });

  it("delivery ?field= filter on a localized field 422s", async () => {
    const r = await delivery(p.deliveryToken, "/posts?title=Hello");
    assert.equal(r.status, 422);
    assert.match(r.json.error, /localized/);
  });
});
