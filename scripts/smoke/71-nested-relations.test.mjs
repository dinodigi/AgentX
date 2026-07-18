import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

// Track 1a (v2): relations INSIDE groups/arrays/blocks. The "repeating cards"
// pattern: a services block holds a relation to a cards collection. Adversarial
// focus: the nested {id,label} channel must obey the SAME fail-closed gating as
// top-level relations (56-relation-label-leak) — a publicFilter-hidden target's
// label must never leak through a nested site.
describe("nested relations (relations-in-blocks)", () => {
  let p, cardId, hiddenId;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("nested-relations");

    const cards = await mcp(p.mcpToken, "define_collection", {
      name: "cards",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
    assert.ok(cards.ok, cards.errorText);
    const hidden = await mcp(p.mcpToken, "define_collection", {
      name: "hidden_cards",
      publicFilter: [{ field: "published", op: "eq", value: true }],
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "published", label: "P", type: "boolean", publicRead: true },
      ],
    });
    assert.ok(hidden.ok, hidden.errorText);

    cardId = (await mcp(p.mcpToken, "create_entry", { collection: "cards", data: { title: "Card A" } })).value.id;
    hiddenId = (
      await mcp(p.mcpToken, "create_entry", {
        collection: "hidden_cards",
        data: { title: "UNPUBLISHED-SECRET-TITLE", published: false },
      })
    ).value.id;

    const pages = await mcp(p.mcpToken, "define_collection", {
      name: "pages",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        {
          name: "sidebar",
          label: "Sidebar",
          type: "group",
          publicRead: true,
          fields: [{ name: "featured", label: "F", type: "relation", targetCollection: "cards", labelField: "title" }],
        },
        {
          name: "body",
          label: "Body",
          type: "array",
          publicRead: true,
          blocks: [
            {
              name: "services",
              label: "Services",
              fields: [
                { name: "heading", label: "H", type: "text" },
                { name: "card", label: "Card", type: "relation", targetCollection: "cards", labelField: "title" },
                { name: "promo", label: "Promo", type: "relation", targetCollection: "hidden_cards", labelField: "title" },
              ],
            },
          ],
        },
      ],
    });
    assert.ok(pages.ok, pages.errorText);
  });

  it("nested relations resolve to {id,label} in blocks AND groups, _type preserved", async () => {
    const c = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: {
        title: "Home",
        sidebar: { featured: cardId },
        body: [{ _type: "services", heading: "What we do", card: cardId, promo: hiddenId }],
      },
    });
    assert.ok(c.ok, c.errorText);
    const r = await delivery(p.deliveryToken, "/pages");
    assert.equal(r.status, 200);
    const row = r.json.data[0];
    assert.equal(row.body[0]._type, "services");
    assert.deepEqual(row.body[0].card, { id: cardId, label: "Card A" });
    assert.deepEqual(row.sidebar.featured, { id: cardId, label: "Card A" });
  });

  it("ADVERSARIAL: a publicFilter-hidden target's label never leaks via a nested site", async () => {
    const r = await delivery(p.deliveryToken, "/pages");
    const promo = r.json.data[0].body[0].promo;
    assert.equal(promo.id, hiddenId);
    assert.equal(promo.label, hiddenId, "fail-closed: label must be the id, not the hidden title");
    assert.ok(!JSON.stringify(r.json).includes("UNPUBLISHED-SECRET-TITLE"), "hidden label nowhere in payload");
  });

  it("trusted MCP reads still resolve the hidden label", async () => {
    const r = await mcp(p.mcpToken, "query_entries", { collection: "pages" });
    assert.ok(r.ok, r.errorText);
    const rows = r.value.entries ?? r.value;
    assert.equal(rows[0].data?.body?.[0]?.promo?.label ?? rows[0].body?.[0]?.promo?.label, "UNPUBLISHED-SECRET-TITLE");
  });

  it("a dangling nested relation id is rejected with the exact path", async () => {
    const r = await mcp(p.mcpToken, "create_entry", {
      collection: "pages",
      data: { title: "Bad", body: [{ _type: "services", card: "00000000-0000-4000-8000-000000000000" }] },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /body\[0\]\.card/, r.errorText);
    assert.match(r.errorText, /no entry .* in "cards"/i);
  });

  it("the other nested bans still hold (computed inside a group rejected)", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "bad",
      fields: [
        {
          name: "g",
          label: "G",
          type: "group",
          fields: [{ name: "c", label: "C", type: "text", computed: { fn: "uuid" } }],
        },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /computed.*not supported inside/i, r.errorText);
  });
});
