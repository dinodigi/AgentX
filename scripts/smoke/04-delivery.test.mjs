import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

describe("delivery API projection + gates", () => {
  let p, authorId;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("delivery");
    await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [{ name: "name", label: "Name", type: "text", publicRead: true }],
    });
    const a = await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Ada" } });
    authorId = a.value.id;

    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "author", label: "Author", type: "relation", targetCollection: "authors", labelField: "name", publicRead: true },
        { name: "internal", label: "Internal", type: "text" },
        { name: "approved", label: "Approved", type: "boolean" },
      ],
      publicFilter: [{ field: "approved", op: "eq", value: true }],
    });
    await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: { title: "Visible", author: authorId, internal: "hide-me", approved: true },
    });
    await mcp(p.mcpToken, "create_entry", {
      collection: "posts",
      data: { title: "Hidden pending", approved: false },
    });

    await mcp(p.mcpToken, "define_collection", {
      name: "inbox",
      publicWrite: true,
      fields: [
        { name: "email", label: "Email", type: "text", required: true },
        { name: "msg", label: "Msg", type: "text" },
      ],
    });
  });
  after(() => p.destroy());

  it("projects only public fields; relations resolve to {id,label}", async () => {
    const r = await delivery(p.deliveryToken, "/posts");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 1, "publicFilter hides pending row");
    const row = r.json.data[0];
    assert.equal(row.title, "Visible");
    assert.ok(!("internal" in row), "private field must be absent");
    assert.deepEqual(row.author, { id: authorId, label: "Ada" });
  });

  it("single-entry GET respects publicFilter with 404", async () => {
    const all = await mcp(p.mcpToken, "query_entries", { collection: "posts" });
    const hidden = all.value.entries.find((r) => r.data.title === "Hidden pending");
    const r = await delivery(p.deliveryToken, `/posts/${hidden.id}`);
    assert.equal(r.status, 404);
  });

  it("collection with zero public fields is 404", async () => {
    const r = await delivery(p.deliveryToken, "/inbox");
    assert.equal(r.status, 404);
  });

  it("public POST: 201 valid, 422 invalid, 403 when publicWrite off", async () => {
    const ok = await delivery(p.deliveryToken, "/inbox", { method: "POST", body: { email: "a@b.c" } });
    assert.equal(ok.status, 201);

    const invalid = await delivery(p.deliveryToken, "/inbox", { method: "POST", body: {} });
    assert.equal(invalid.status, 422);
    assert.ok(/Required/.test(invalid.json.error));

    const forbidden = await delivery(p.deliveryToken, "/posts", { method: "POST", body: { title: "x" } });
    assert.equal(forbidden.status, 403);
  });

  it("rate limit: 429 within one window for a single IP", async () => {
    const ip = "10.99.99.99";
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await delivery(p.deliveryToken, "/inbox", { method: "POST", body: {}, ip });
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }
    assert.ok(got429, "expected a 429 within 25 rapid posts from one IP");
  });
});
