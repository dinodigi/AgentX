import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  mcp,
  startWebhookReceiver,
  waitFor,
  randomUUID,
} from "./helpers.mjs";

describe("transact: all-or-nothing entry batches", () => {
  let p, receiver;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("transact");
    receiver = await startWebhookReceiver();
    const authors = await mcp(p.mcpToken, "define_collection", {
      name: "authors",
      fields: [{ name: "name", label: "Name", type: "text", required: true, unique: true }],
    });
    assert.ok(authors.ok, authors.errorText);
    const posts = await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [{ name: "title", label: "Title", type: "text", required: true }],
      events: { created: [{ type: "webhook", url: receiver.url }] },
    });
    assert.ok(posts.ok, posts.errorText);
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  const count = async (collection) => {
    const r = await mcp(p.mcpToken, "count_entries", { collection });
    assert.ok(r.ok, r.errorText);
    return r.value.count;
  };
  const makePost = async (title) => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "posts", data: { title } });
    assert.ok(r.ok, r.errorText);
    return r.value.id;
  };

  it("happy path: create + update + delete across two collections commit together", async () => {
    const toUpdate = await makePost("before");
    const toDelete = await makePost("doomed");

    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "authors", data: { name: "Ada" } },
        { op: "update", collection: "posts", id: toUpdate, data: { title: "after" } },
        { op: "delete", collection: "posts", id: toDelete },
      ],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.applied, true);
    assert.equal(r.value.results.length, 3);
    assert.deepEqual(r.value.results.map((x) => x.op), ["create", "update", "delete"]);

    const updated = await mcp(p.mcpToken, "get_entry", { collection: "posts", id: toUpdate });
    assert.equal(updated.value.data.title, "after");
    const gone = await mcp(p.mcpToken, "get_entry", { collection: "posts", id: toDelete });
    assert.ok(!gone.ok, "deleted post should be gone");
    const author = await mcp(p.mcpToken, "query_entries", {
      collection: "authors",
      where: [{ field: "name", op: "eq", value: "Ada" }],
    });
    assert.equal(author.value.entries.length, 1);
  });

  it("mid-batch validation failure names the op and applies nothing", async () => {
    const before = await count("authors");
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "authors", data: { name: "Grace" } },
        { op: "create", collection: "authors", data: {} }, // missing required name
      ],
    });
    assert.ok(!r.ok, "batch should fail");
    assert.ok(/op\[1\]/.test(r.errorText), r.errorText);
    assert.ok(/rolled back — no ops applied/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /\[E_VALIDATION\]/);
    assert.equal(await count("authors"), before, "first create must not persist");
  });

  it("delete of a missing id aborts the whole batch with E_NOT_FOUND", async () => {
    const survivor = await makePost("survivor");
    const before = await count("posts");
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "update", collection: "posts", id: survivor, data: { title: "touched" } },
        { op: "delete", collection: "posts", id: randomUUID() },
      ],
    });
    assert.ok(!r.ok && /\[E_NOT_FOUND\]/.test(r.errorText), r.errorText);
    assert.ok(/op\[1\]/.test(r.errorText), r.errorText);
    assert.equal(await count("posts"), before, "count unchanged");
    // the earlier update rolled back too
    const check = await mcp(p.mcpToken, "get_entry", { collection: "posts", id: survivor });
    assert.equal(check.value.data.title, "survivor");
  });

  it("unique violation inside a batch rolls back the earlier create", async () => {
    await mcp(p.mcpToken, "create_entry", { collection: "authors", data: { name: "Bob" } });
    const before = await count("authors");
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "authors", data: { name: "Carol" } },
        { op: "create", collection: "authors", data: { name: "Bob" } }, // dup
      ],
    });
    assert.ok(!r.ok && /op\[1\]/.test(r.errorText), r.errorText);
    assert.equal(await count("authors"), before, "Carol must not persist");
    const carol = await mcp(p.mcpToken, "query_entries", {
      collection: "authors",
      where: [{ field: "name", op: "eq", value: "Carol" }],
    });
    assert.equal(carol.value.entries.length, 0);
  });

  it("events fire only after commit — none on rollback, ordered on success", async () => {
    receiver.received.length = 0;

    // Rollback: a valid create then a failing delete — receiver must stay empty.
    const bad = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "posts", data: { title: "ghost" } },
        { op: "delete", collection: "posts", id: randomUUID() },
      ],
    });
    assert.ok(!bad.ok, bad.errorText);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(
      receiver.received.filter((x) => x.event === "entry.created").length,
      0,
      "no events should fire on rollback",
    );

    // Commit: two creates — both created events arrive.
    const good = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "posts", data: { title: "first" } },
        { op: "create", collection: "posts", data: { title: "second" } },
      ],
    });
    assert.ok(good.ok, good.errorText);
    const both = await waitFor(
      () =>
        receiver.received.filter((x) => x.event === "entry.created").length === 2
          ? receiver.received.filter((x) => x.event === "entry.created")
          : null,
    );
    assert.ok(both, "both created events should arrive after commit");
    assert.deepEqual(both.map((x) => x.entry.data.title), ["first", "second"]);
  });
});

describe("transact: cross-op $ref (B3)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("transact-ref");
    await mcp(p.mcpToken, "define_collection", {
      name: "orders",
      fields: [{ name: "label", label: "Label", type: "text", required: true }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "line_items",
      fields: [
        { name: "sku", label: "SKU", type: "text", required: true },
        { name: "order", label: "Order", type: "relation", targetCollection: "orders", labelField: "label" },
      ],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "text", label: "Text", type: "text", required: true }],
    });
  });
  after(() => p.destroy());

  it("create-then-relate in one batch: line item links to the freshly created order", async () => {
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "orders", data: { label: "PO-1" }, ref: "order" },
        { op: "create", collection: "line_items", data: { sku: "A1", order: "$ref:order" } },
      ],
    });
    assert.ok(r.ok, r.errorText);
    const orderId = r.value.results[0].id;
    const li = await mcp(p.mcpToken, "get_entry", { collection: "line_items", id: r.value.results[1].id });
    // relation resolves to {id, label}
    assert.equal(li.value.data.order.id, orderId);
    assert.equal(li.value.data.order.label, "PO-1");
  });

  it("forward ref (points at a later op) is rejected", async () => {
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "line_items", data: { sku: "B1", order: "$ref:order" } },
        { op: "create", collection: "orders", data: { label: "PO-2" }, ref: "order" },
      ],
    });
    assert.ok(!r.ok && /op\[0\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /only point to earlier create ops/);
  });

  it("relation $ref whose target collection mismatches is rejected", async () => {
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "notes", data: { text: "hi" }, ref: "note" },
        { op: "create", collection: "line_items", data: { sku: "C1", order: "$ref:note" } },
      ],
    });
    assert.ok(!r.ok && /op\[1\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /targets "orders" but its \$ref creates in "notes"/);
  });

  it("$ref in a non-relation field is stored literally", async () => {
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "orders", data: { label: "PO-3" }, ref: "order" },
        { op: "create", collection: "notes", data: { text: "$ref:order" } },
      ],
    });
    assert.ok(r.ok, r.errorText);
    const note = await mcp(p.mcpToken, "get_entry", { collection: "notes", id: r.value.results[1].id });
    assert.equal(note.value.data.text, "$ref:order");
  });

  it("rollback when a later op fails leaves neither the order nor the line item", async () => {
    const before = await mcp(p.mcpToken, "count_entries", { collection: "orders" });
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "orders", data: { label: "PO-doomed" }, ref: "order" },
        { op: "create", collection: "line_items", data: { order: "$ref:order" } }, // missing required sku
      ],
    });
    assert.ok(!r.ok && /op\[1\]/.test(r.errorText), r.errorText);
    const after = await mcp(p.mcpToken, "count_entries", { collection: "orders" });
    assert.equal(after.value.count, before.value.count, "the order must not persist");
    const q = await mcp(p.mcpToken, "query_entries", {
      collection: "orders",
      where: [{ field: "label", op: "eq", value: "PO-doomed" }],
    });
    assert.equal(q.value.entries.length, 0);
  });
});

describe("transact: update_if op + dryRun (B4)", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("transact-cas");
    await mcp(p.mcpToken, "define_collection", {
      name: "shows",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "seats", label: "Seats", type: "number", min: 0 },
      ],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "bookings",
      fields: [{ name: "who", label: "Who", type: "text", required: true }],
    });
  });
  after(() => p.destroy());

  const makeShow = async (seats) => {
    const r = await mcp(p.mcpToken, "create_entry", { collection: "shows", data: { title: "Gala", seats } });
    assert.ok(r.ok, r.errorText);
    return r.value.id;
  };

  it("book-a-seat composite: decrement seats AND create booking atomically", async () => {
    const show = await makeShow(1);
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "update_if", collection: "shows", id: show, if: [{ field: "seats", op: "gt", value: 0 }], increment: { field: "seats", by: -1 } },
        { op: "create", collection: "bookings", data: { who: "Ada" } },
      ],
    });
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.results.map((x) => x.op), ["update_if", "create"]);
    const after = await mcp(p.mcpToken, "get_entry", { collection: "shows", id: show });
    assert.equal(after.value.data.seats, 0);
    assert.equal((await mcp(p.mcpToken, "count_entries", { collection: "bookings" })).value.count, 1);
  });

  it("failed CAS aborts the whole batch — booking is NOT created, seats unchanged", async () => {
    const show = await makeShow(0); // sold out
    const bookingsBefore = (await mcp(p.mcpToken, "count_entries", { collection: "bookings" })).value.count;
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "update_if", collection: "shows", id: show, if: [{ field: "seats", op: "gt", value: 0 }], increment: { field: "seats", by: -1 } },
        { op: "create", collection: "bookings", data: { who: "Bob" } },
      ],
    });
    assert.ok(!r.ok && /op\[0\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /\[E_CONFLICT\]/);
    // the if-guard fails first (correct precedence): names the clause, not the bound
    assert.match(r.errorText, /condition not met: seats gt 0/);
    // race-free diagnosis: no "as of the latest read" hedge inside a tx
    assert.doesNotMatch(r.errorText, /as of the latest read/);
    const after = await mcp(p.mcpToken, "get_entry", { collection: "shows", id: show });
    assert.equal(after.value.data.seats, 0);
    assert.equal((await mcp(p.mcpToken, "count_entries", { collection: "bookings" })).value.count, bookingsBefore);
  });

  it("concurrent book-a-seat on 1 seat: exactly one wins, no oversell, loser has zero partial rows", async () => {
    const show = await makeShow(1);
    const book = (who) =>
      mcp(p.mcpToken, "transact", {
        ops: [
          { op: "update_if", collection: "shows", id: show, if: [{ field: "seats", op: "gt", value: 0 }], increment: { field: "seats", by: -1 } },
          { op: "create", collection: "bookings", data: { who } },
        ],
      });
    const [a, b] = await Promise.all([book("X"), book("Y")]);
    const wins = [a, b].filter((r) => r.ok).length;
    assert.equal(wins, 1, "exactly one booking should win");
    const seats = (await mcp(p.mcpToken, "get_entry", { collection: "shows", id: show })).value.data.seats;
    assert.equal(seats, 0, "never oversold");
  });

  it("absent-field increment inside a batch gets the 'unset' diagnosis with op index", async () => {
    const noSeats = await mcp(p.mcpToken, "create_entry", { collection: "shows", data: { title: "TBD" } });
    const r = await mcp(p.mcpToken, "transact", {
      ops: [{ op: "update_if", collection: "shows", id: noSeats.value.id, increment: { field: "seats", by: 1 } }],
    });
    assert.ok(!r.ok && /op\[0\]/.test(r.errorText), r.errorText);
    assert.match(r.errorText, /field "seats" is not set on this entry/);
  });

  it("dryRun validates and returns a plan without writing", async () => {
    const show = await makeShow(5);
    const before = (await mcp(p.mcpToken, "count_entries", { collection: "bookings" })).value.count;
    const r = await mcp(p.mcpToken, "transact", {
      dryRun: true,
      ops: [
        { op: "update_if", collection: "shows", id: show, if: [{ field: "seats", op: "gt", value: 0 }], increment: { field: "seats", by: -1 } },
        { op: "create", collection: "bookings", data: { who: "Zoe" } },
      ],
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.applied, false);
    assert.equal(r.value.dryRun, true);
    assert.equal(r.value.plan.length, 2);
    assert.deepEqual(r.value.plan.map((x) => x.op), ["update_if", "create"]);
    // nothing written
    assert.equal((await mcp(p.mcpToken, "get_entry", { collection: "shows", id: show })).value.data.seats, 5);
    assert.equal((await mcp(p.mcpToken, "count_entries", { collection: "bookings" })).value.count, before);
  });

  it("dryRun surfaces a validation error with the op index, still writing nothing", async () => {
    const r = await mcp(p.mcpToken, "transact", {
      dryRun: true,
      ops: [
        { op: "create", collection: "bookings", data: { who: "ok" } },
        { op: "create", collection: "shows", data: {} }, // missing required title
      ],
    });
    assert.ok(!r.ok && /op\[1\]/.test(r.errorText), r.errorText);
  });
});

describe("transact: batch idempotency (B5)", () => {
  let p, receiver;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("transact-idem");
    receiver = await startWebhookReceiver();
    await mcp(p.mcpToken, "define_collection", {
      name: "widgets",
      fields: [{ name: "name", label: "Name", type: "text", required: true, unique: true }],
      events: { created: [{ type: "webhook", url: receiver.url }] },
    });
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });
  const count = async () => (await mcp(p.mcpToken, "count_entries", { collection: "widgets" })).value.count;

  it("same key twice: second call replays the original ids, no duplicate rows or events", async () => {
    receiver.received.length = 0;
    const key = "batch-" + randomUUID();
    const first = await mcp(p.mcpToken, "transact", {
      idempotencyKey: key,
      ops: [
        { op: "create", collection: "widgets", data: { name: "w1" } },
        { op: "create", collection: "widgets", data: { name: "w2" } },
      ],
    });
    assert.ok(first.ok, first.errorText);
    assert.ok(!first.value.replayed, "first call is not a replay");
    const afterFirst = await count();

    const second = await mcp(p.mcpToken, "transact", {
      idempotencyKey: key,
      ops: [
        { op: "create", collection: "widgets", data: { name: "w1" } },
        { op: "create", collection: "widgets", data: { name: "w2" } },
      ],
    });
    assert.ok(second.ok, second.errorText);
    assert.equal(second.value.replayed, true, "second call replays");
    assert.deepEqual(
      second.value.results.map((x) => x.id),
      first.value.results.map((x) => x.id),
      "replay returns identical ids",
    );
    assert.equal(await count(), afterFirst, "no duplicate rows");

    // events: only the first batch's 2 creates fired
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(receiver.received.filter((x) => x.event === "entry.created").length, 2, "no duplicate events");
  });

  it("a batch that rolls back on a unique violation does NOT consume the key", async () => {
    const key = "retry-" + randomUUID();
    await mcp(p.mcpToken, "create_entry", { collection: "widgets", data: { name: "taken" } });
    const before = await count();

    // First attempt collides on the second op → rolls back, receipt rolled back too.
    const bad = await mcp(p.mcpToken, "transact", {
      idempotencyKey: key,
      ops: [
        { op: "create", collection: "widgets", data: { name: "fresh1" } },
        { op: "create", collection: "widgets", data: { name: "taken" } }, // dup
      ],
    });
    assert.ok(!bad.ok && /op\[1\]/.test(bad.errorText), bad.errorText);
    assert.equal(await count(), before, "nothing persisted");

    // Retry the SAME key with fixed data → succeeds (key was not consumed).
    const good = await mcp(p.mcpToken, "transact", {
      idempotencyKey: key,
      ops: [
        { op: "create", collection: "widgets", data: { name: "fresh1" } },
        { op: "create", collection: "widgets", data: { name: "fresh2" } },
      ],
    });
    assert.ok(good.ok, good.errorText);
    assert.ok(!good.value.replayed, "retry is a real apply, not a replay");
    assert.equal(await count(), before + 2);
  });
});

describe("transact: Phase 9 review fixes", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("transact-fixes");
    await mcp(p.mcpToken, "define_collection", {
      name: "orders",
      fields: [{ name: "label", label: "Label", type: "text", required: true }],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "line_items",
      fields: [
        { name: "sku", label: "SKU", type: "text", required: true },
        { name: "order", label: "Order", type: "relation", targetCollection: "orders", labelField: "label" },
      ],
    });
  });
  after(() => p.destroy());

  it("A: update_if can relate to a same-batch $ref-created row", async () => {
    const li = await mcp(p.mcpToken, "create_entry", { collection: "line_items", data: { sku: "L1" } });
    assert.ok(li.ok, li.errorText);
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "create", collection: "orders", data: { label: "PO-A" }, ref: "order" },
        { op: "update_if", collection: "line_items", id: li.value.id, data: { order: "$ref:order" } },
      ],
    });
    assert.ok(r.ok, r.errorText);
    const linked = await mcp(p.mcpToken, "get_entry", { collection: "line_items", id: li.value.id });
    assert.equal(linked.value.data.order.label, "PO-A");
  });

  it("D: a batch that both deletes a row and relates to it is rejected", async () => {
    const o = await mcp(p.mcpToken, "create_entry", { collection: "orders", data: { label: "PO-D" } });
    assert.ok(o.ok, o.errorText);
    const before = (await mcp(p.mcpToken, "count_entries", { collection: "line_items" })).value.count;
    const r = await mcp(p.mcpToken, "transact", {
      ops: [
        { op: "delete", collection: "orders", id: o.value.id },
        { op: "create", collection: "line_items", data: { sku: "L2", order: o.value.id } },
      ],
    });
    assert.ok(!r.ok, "should reject");
    assert.match(r.errorText, /cannot both delete a row and relate to it/);
    // nothing applied — the order still exists
    const still = await mcp(p.mcpToken, "get_entry", { collection: "orders", id: o.value.id });
    assert.ok(still.ok, "order must not be deleted");
    assert.equal((await mcp(p.mcpToken, "count_entries", { collection: "line_items" })).value.count, before);
  });
});
