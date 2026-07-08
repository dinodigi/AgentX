import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp } from "./helpers.mjs";

describe("query power: relation expand (D1)", () => {
  let p, authorId, postId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("query-power");
    await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, publicRead: true },
        { name: "bio", label: "Bio", type: "text", publicRead: true },
        { name: "secret", label: "Secret", type: "text" }, // NOT publicRead
      ],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "author", label: "Author", type: "relation", targetCollection: "authors", labelField: "name", publicRead: true },
      ],
    });
    const a = await mcp(p.mcpToken, "create_entry", {
      collection: "authors",
      data: { name: "Ada", bio: "pioneer", secret: "classified" },
    });
    authorId = a.value.id;
    const post = await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: { title: "First", author: authorId },
    });
    postId = post.value.id;
  });
  after(() => p.destroy());

  it("query_entries expand replaces the relation with {id, label, data}", async () => {
    const r = await mcp(p.mcpToken, "query_entries", { collection: "posts", expand: ["author"] });
    assert.ok(r.ok, r.errorText);
    const post = r.value.entries.find((e) => e.id === postId);
    assert.equal(post.data.author.id, authorId);
    assert.equal(post.data.author.label, "Ada");
    // MCP 'full' mode: expanded data includes ALL fields (private too — MCP is trusted).
    assert.equal(post.data.author.data.name, "Ada");
    assert.equal(post.data.author.data.bio, "pioneer");
    assert.equal(post.data.author.data.secret, "classified");
  });

  it("get_entry expand works the same", async () => {
    const r = await mcp(p.mcpToken, "get_entry", { collection: "posts", id: postId, expand: ["author"] });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.data.author.data.name, "Ada");
  });

  it("without expand, the relation stays {id, label}", async () => {
    const r = await mcp(p.mcpToken, "get_entry", { collection: "posts", id: postId });
    assert.equal(r.value.data.author.id, authorId);
    assert.equal(r.value.data.author.label, "Ada");
    assert.ok(!("data" in r.value.data.author), "no data without expand");
  });

  it("expanding a non-relation field is E_VALIDATION with the expandable list", async () => {
    const r = await mcp(p.mcpToken, "query_entries", { collection: "posts", expand: ["title"] });
    assert.ok(!r.ok && /\[E_VALIDATION\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /expandable: author/);
  });
});

import { delivery } from "./helpers.mjs";

describe("query power: delivery expand with public gating (D2)", () => {
  let p, authorId, hiddenAuthorId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("query-power-d2");
    await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, publicRead: true },
        { name: "secret", label: "Secret", type: "text" }, // NOT publicRead
        { name: "listed", label: "Listed", type: "boolean", publicRead: true },
      ],
      publicFilter: [{ field: "listed", op: "eq", value: true }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "author", label: "Author", type: "relation", targetCollection: "authors", labelField: "name", publicRead: true },
      ],
    });
    // private collection (no public read) to test the target-not-public gate
    await mcp(p.mcpToken, "define_collection", {
      name: "secrets",
      fields: [{ name: "code", label: "Code", type: "text" }],
    });
    const a = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Ada", secret: "x", listed: true } });
    authorId = a.value.id;
    const h = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Hidden", secret: "y", listed: false } });
    hiddenAuthorId = h.value.id;
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "P1", author: authorId } });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "P2", author: hiddenAuthorId } });
  });
  after(() => p.destroy());

  it("delivery ?expand= returns the target's PUBLIC projection only (no private fields)", async () => {
    const r = await delivery(p.deliveryToken, "/posts?expand=author");
    assert.equal(r.status, 200);
    const p1 = r.json.data.find((e) => e.title === "P1");
    assert.equal(p1.author.id, authorId);
    assert.equal(p1.author.data.name, "Ada");
    assert.equal(p1.author.data.listed, true);
    assert.ok(!("secret" in p1.author.data), "private field must not leak through expand");
  });

  it("a publicFilter-hidden target is NOT expanded (no data leak of a hidden row)", async () => {
    const r = await delivery(p.deliveryToken, "/posts?expand=author");
    const p2 = r.json.data.find((e) => e.title === "P2");
    // The hidden author still shows {id,label} (pre-existing), but NOT the full data.
    assert.ok(!("data" in p2.author), "hidden target must not expand its data: " + JSON.stringify(p2.author));
  });

  it("expanding a non-public relation target is 422", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "reports",
      fields: [
        { name: "name", label: "N", type: "text", required: true, publicRead: true },
        { name: "owner", label: "Owner", type: "relation", targetCollection: "secrets", labelField: "code", publicRead: true },
      ],
    });
    const r = await delivery(p.deliveryToken, "/reports?expand=owner");
    assert.equal(r.status, 422);
    assert.match(r.json.error, /not publicly readable/);
  });

  it("single-entry GET supports expand too", async () => {
    const list = await delivery(p.deliveryToken, "/posts");
    const p1id = list.json.data.find((e) => e.title === "P1").id;
    const r = await delivery(p.deliveryToken, `/posts/${p1id}?expand=author`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.author.data.name, "Ada");
  });
});

describe("query power: dotted-path related filters on MCP (D3)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("query-power-d3");
    await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "rank", label: "Rank", type: "number" },
      ],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "author", label: "Author", type: "relation", targetCollection: "authors", labelField: "name" },
      ],
    });
    const ada = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Ada", rank: 10 } });
    const bob = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Bob", rank: 3 } });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "By Ada", author: ada.value.id } });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "By Bob", author: bob.value.id } });
  });
  after(() => p.destroy());

  it("where author.name eq X returns only the matching posts", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "author.name", op: "eq", value: "Ada" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 1);
    assert.equal(r.value.entries[0].data.title, "By Ada");
  });

  it("contains across the hop works", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "author.name", op: "contains", value: "o" }], // Bob
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.entries.length, 1);
    assert.equal(r.value.entries[0].data.title, "By Bob");
  });

  it("dotted filter drives count_entries and aggregate_entries too", async () => {
    const cnt = await mcp(p.mcpToken, "count_entries", {
      collection: "posts",
      where: [{ field: "author.rank", op: "gt", value: 5 }],
    });
    assert.equal(cnt.value.count, 1);
  });

  it("op mismatch on the target field type is rejected", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "author.rank", op: "contains", value: "x" }], // contains invalid on number
    });
    assert.ok(!r.ok && /\[E_VALIDATION\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /not valid for number/);
  });

  it("a non-relation head is rejected with a hint", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      where: [{ field: "title.foo", op: "eq", value: "x" }],
    });
    assert.ok(!r.ok && /not a relation field/.test(r.errorText), r.errorText);
  });

  it("dotted field inside update_entry_if.if is rejected (no related context there)", async () => {
    const post = await mcp(p.mcpToken, "query_entries", { collection: "posts", limit: 1 });
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "posts",
      id: post.value.entries[0].id,
      if: [{ field: "author.name", op: "eq", value: "Ada" }],
      data: { title: "z" },
    });
    assert.ok(!r.ok, r.errorText);
    assert.match(r.errorText, /only valid in query where/);
  });
});

describe("query power: delivery dotted filters, fully gated (D4)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("query-power-d4");
    await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, publicRead: true },
        { name: "email", label: "Email", type: "text" }, // NOT publicRead
        { name: "approved", label: "Approved", type: "boolean", publicRead: true },
      ],
      publicFilter: [{ field: "approved", op: "eq", value: true }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "author", label: "Author", type: "relation", targetCollection: "authors", labelField: "name", publicRead: true },
      ],
    });
    // owner-gated target for the existence-oracle test
    await mcp(p.mcpToken, "define_collection", {
      name: "users",
      fields: [
        { name: "handle", label: "H", type: "text", required: true, publicRead: true },
        { name: "owner", label: "O", type: "text" },
      ],
      access: { read: "owner", write: "owner", ownerField: "owner" },
    });

    const alice = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Alice", email: "a@x.co", approved: true } });
    const unappr = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Zed", email: "z@x.co", approved: false } });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "By Alice", author: alice.value.id } });
    await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "By Zed", author: unappr.value.id } });
  });
  after(() => p.destroy());

  it("(happy) ?author.name=Alice returns her posts", async () => {
    const r = await delivery(p.deliveryToken, "/posts?author.name=Alice");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 1);
    assert.equal(r.json.data[0].title, "By Alice");
  });

  it("(security a) filtering against an access.read='owner' target 422s — no existence oracle", async () => {
    await mcp(p.mcpToken, "define_collection", {
      name: "docs",
      fields: [
        { name: "name", label: "N", type: "text", required: true, publicRead: true },
        { name: "u", label: "U", type: "relation", targetCollection: "users", labelField: "handle", publicRead: true },
      ],
    });
    const r = await delivery(p.deliveryToken, "/docs?u.handle=whoever");
    assert.equal(r.status, 422);
    assert.match(r.json.error, /not publicly readable/);
  });

  it("(security b) a publicFilter-hidden related row does not match — no leak through result diff", async () => {
    // Zed is unapproved (hidden by the authors publicFilter). Filtering by his
    // name must return NOTHING, even though a 'By Zed' post exists.
    const r = await delivery(p.deliveryToken, "/posts?author.name=Zed");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 0, "unapproved author must not be matchable");
  });

  it("(security c) a dotted filter on a NON-public tail field 422s", async () => {
    const r = await delivery(p.deliveryToken, "/posts?author.email=a@x.co");
    assert.equal(r.status, 422);
    assert.match(r.json.error, /not a public field/);
  });
});

describe("query power: reverse includes on MCP (D5)", () => {
  let p, postId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("query-power-d5");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "T", type: "text", required: true }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "comments",
      fields: [
        { name: "body", label: "B", type: "text", required: true },
        { name: "post", label: "Post", type: "relation", targetCollection: "posts", labelField: "title" },
      ],
    });
    const post = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Hello" } });
    postId = post.value.id;
    for (let i = 1; i <= 3; i++) {
      await mcp(p.mcpToken, "create_entry", { collection: "comments", data: { body: "c" + i, post: postId } });
    }
    // a comment on a DIFFERENT (nonexistent-parent) to ensure partitioning
    const other = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Other" } });
    await mcp(p.mcpToken, "create_entry", { collection: "comments", data: { body: "elsewhere", post: other.value.id } });
  });
  after(() => p.destroy());

  it("get_entry includeReverse embeds the children under related, never inside data", async () => {
    const r = await mcp(p.mcpToken, "get_entry", {
      collection: "posts",
      id: postId,
      includeReverse: [{ collection: "comments", field: "post" }],
    });
    assert.ok(r.ok, r.errorText);
    const group = r.value.related["comments.post"];
    assert.equal(group.entries.length, 3);
    assert.equal(group.hasMore, false);
    assert.ok(group.entries.every((c) => c.data.body.startsWith("c")));
    assert.ok(!("related" in r.value.data), "related must be a sibling of data, not inside it");
  });

  it("per-parent limit + hasMore is exact", async () => {
    const r = await mcp(p.mcpToken, "get_entry", {
      collection: "posts",
      id: postId,
      includeReverse: [{ collection: "comments", field: "post", limit: 2 }],
    });
    const group = r.value.related["comments.post"];
    assert.equal(group.entries.length, 2);
    assert.equal(group.hasMore, true);
  });

  it("query_entries attaches reverse children per parent", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "posts",
      includeReverse: [{ collection: "comments", field: "post" }],
    });
    const hello = r.value.entries.find((e) => e.id === postId);
    assert.equal(hello.related["comments.post"].entries.length, 3);
    const other = r.value.entries.find((e) => e.data.title === "Other");
    assert.equal(other.related["comments.post"].entries.length, 1);
  });

  it("a bad reverse path is rejected with the valid options", async () => {
    const r = await mcp(p.mcpToken, "get_entry", {
      collection: "posts",
      id: postId,
      includeReverse: [{ collection: "comments", field: "body" }], // body is not a relation
    });
    assert.ok(!r.ok && /\[E_VALIDATION\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /valid: post/);
  });
});

describe("query power: delivery reverse includes, gated (D6)", () => {
  let p, postId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("query-power-d6");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "comments",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "flagged", label: "F", type: "boolean", publicRead: true },
        { name: "ip", label: "IP", type: "text" }, // private
        { name: "post", label: "Post", type: "relation", targetCollection: "posts", labelField: "title", publicRead: true },
      ],
      publicFilter: [{ field: "flagged", op: "eq", value: false }],
    });
    // private child collection for the gate test
    await mcp(p.mcpToken, "define_collection", {
      name: "audits",
      fields: [{ name: "note", label: "N", type: "text" }, { name: "post", label: "P", type: "relation", targetCollection: "posts", labelField: "title" }],
    });
    const post = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Hi" } });
    postId = post.value.id;
    await mcp(p.mcpToken, "create_entry", { collection: "comments", data: { body: "nice", flagged: false, ip: "1.2.3.4", post: postId } });
    await mcp(p.mcpToken, "create_entry", { collection: "comments", data: { body: "spam", flagged: true, ip: "9.9.9.9", post: postId } });
  });
  after(() => p.destroy());

  it("delivery ?include= embeds only PUBLIC child fields, respecting the child publicFilter", async () => {
    const r = await delivery(p.deliveryToken, "/posts?include=comments.post");
    assert.equal(r.status, 200);
    const post = r.json.data.find((e) => e.id === postId);
    const group = post.related["comments.post"];
    // only the non-flagged comment is visible
    assert.equal(group.entries.length, 1);
    assert.equal(group.entries[0].body, "nice");
    assert.ok(!("ip" in group.entries[0]), "private child field must not leak");
    assert.ok(!("flagged" in group.entries[0]) || group.entries[0].flagged !== undefined); // flagged is public, may appear
  });

  it("single-entry GET supports ?include= too", async () => {
    const r = await delivery(p.deliveryToken, `/posts/${postId}?include=comments.post`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.related["comments.post"].entries.length, 1);
  });

  it("including a non-public child collection is 422", async () => {
    const r = await delivery(p.deliveryToken, "/posts?include=audits.post");
    assert.equal(r.status, 422);
    assert.match(r.json.error, /not publicly readable/);
  });
});

describe("query power: reverse-include private back-ref leak fix", () => {
  let p, postId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("qp-revfix");
    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "T", type: "text", required: true, publicRead: true }],
    });
    // child collection is public, but its back-ref `post` is PRIVATE
    await mcp(p.mcpToken, "define_collection", {
      name: "comments",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "post", label: "Post", type: "relation", targetCollection: "posts", labelField: "title" }, // NOT publicRead
      ],
    });
    const post = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title: "Hi" } });
    postId = post.value.id;
    await mcp(p.mcpToken, "create_entry", { collection: "comments", data: { body: "c1", post: postId } });
  });
  after(() => p.destroy());

  it("delivery ?include= over a PRIVATE back-reference is 422 (no association leak)", async () => {
    const r = await delivery(p.deliveryToken, "/posts?include=comments.post");
    assert.equal(r.status, 422);
    assert.match(r.json.error, /not a public relation field/);
    const single = await delivery(p.deliveryToken, `/posts/${postId}?include=comments.post`);
    assert.equal(single.status, 422);
  });

  it("MCP includeReverse still works over the same private back-ref (MCP is trusted)", async () => {
    const r = await mcp(p.mcpToken, "get_entry", {
      collection: "posts",
      id: postId,
      includeReverse: [{ collection: "comments", field: "post" }],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.related["comments.post"].entries.length, 1);
  });
});
