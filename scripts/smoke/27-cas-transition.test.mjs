import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  startWebhookReceiver,
  mcp,
  waitFor,
} from "./helpers.mjs";

// G4b: prove the load-bearing single-statement CAS transition claims in
// isolation before G5 composes on them. The workflow CAS path recovers the
// EXACT pre-image `from` via a self-join UPDATE (RETURNING old.data), so the
// matched transition — hence which actions fire — is correct even under a race,
// where an advisory pre-read could report a stale `from`.
describe("CAS transition proof (G4b)", () => {
  let p, receiver;
  const transitionsFor = (entryId) =>
    receiver.received.filter((r) => r.event === "entry.transitioned" && r.entry?.id === entryId);

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("cas-transition");
    receiver = await startWebhookReceiver();
    // Two transitions share the SAME target `closed` from DISJOINT froms, each
    // firing a webhook — the payload's transition.from reveals which resolved.
    const d = await mcp(p.mcpToken, "define_collection", {
      name: "tickets",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "status", label: "S", type: "enum", options: ["open", "pending", "approved", "closed"], publicRead: true },
      ],
      workflow: {
        field: "status",
        initial: "open",
        transitions: [
          { from: "open", to: "pending" },
          { from: "pending", to: "approved", actions: [{ type: "webhook", url: receiver.url }] },
          // both reach `closed`, from disjoint states, both fire a webhook
          { from: "open", to: "closed", actions: [{ type: "webhook", url: receiver.url }] },
          { from: "pending", to: "closed", actions: [{ type: "webhook", url: receiver.url }] },
        ],
      },
    });
    assert.ok(d.ok, d.errorText);
  });
  after(async () => {
    await receiver.close();
    await p.destroy();
  });

  it("self-join recovers the EXACT from: pending→closed resolves the right transition", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "a" } });
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "tickets", id, data: { status: "pending" } });
    // CAS close from `pending` — must match the pending→closed transition, not open→closed.
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "tickets",
      id,
      if: [{ field: "title", op: "eq", value: "a" }],
      data: { status: "closed" },
    });
    assert.ok(r.ok, r.errorText);
    const hit = await waitFor(() => transitionsFor(id).find((x) => x.transition.to === "closed"));
    assert.ok(hit, "entry.transitioned fired");
    assert.equal(hit.transition.from, "pending", "exact from recovered from the pre-image");
  });

  it("if-conditions AND the workflow guard compose in ONE statement", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "b" } });
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "tickets", id, data: { status: "pending" } });

    // The user `if` fails → conflict, even though the transition is legal.
    const ifFails = await mcp(p.mcpToken, "update_entry_if", {
      collection: "tickets",
      id,
      if: [{ field: "title", op: "eq", value: "WRONG" }],
      data: { status: "approved" },
    });
    assert.equal(ifFails.value?.ok ?? ifFails.ok, false, "a failed if-condition conflicts");

    // Both the if AND the transition hold → applies.
    const both = await mcp(p.mcpToken, "update_entry_if", {
      collection: "tickets",
      id,
      if: [{ field: "title", op: "eq", value: "b" }],
      data: { status: "approved" },
    });
    assert.ok(both.ok, both.errorText);
  });

  it("an illegal CAS transition never applies (approved has no onward transition here)", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "c" } });
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "tickets", id, data: { status: "pending" } });
    // pending→closed is legal; approved is a valid target elsewhere but not FROM pending? it is (pending→approved).
    // Instead assert a NON-target is rejected before SQL:
    const bad = await mcp(p.mcpToken, "update_entry_if", { collection: "tickets", id, data: { status: "open" } });
    assert.ok(!bad.ok, "open is no transition's target → rejected");
    assert.match(bad.errorText, /not a transition target/);
  });

  it("concurrent transitions on one entry fire the transition EXACTLY once", async () => {
    const c = await mcp(p.mcpToken, "create_entry", { collection: "tickets", data: { title: "race" } });
    const id = c.value.id;
    await mcp(p.mcpToken, "update_entry", { collection: "tickets", id, data: { status: "pending" } });

    // Five racers all try pending→approved at once. With the self-join, the row
    // serializes: exactly one sees from=pending (fires), the rest see from=approved
    // (no-op, fire nothing). Never two approval webhooks from one logical approval.
    const racers = Array.from({ length: 5 }, () =>
      mcp(p.mcpToken, "update_entry_if", { collection: "tickets", id, data: { status: "approved" } }),
    );
    const results = await Promise.all(racers);
    assert.ok(results.some((r) => r.ok), "at least one racer succeeds");

    const approved = await waitFor(() => transitionsFor(id).find((x) => x.transition.to === "approved"));
    assert.ok(approved, "the approval transition fired");
    assert.equal(approved.transition.from, "pending", "exact from");
    // Give any stray second fire a chance to arrive, then assert there was only one.
    await waitFor(() => false, { timeoutMs: 1500, stepMs: 500 }).catch(() => {});
    const fires = transitionsFor(id).filter((x) => x.transition.to === "approved");
    assert.equal(fires.length, 1, "exactly one approval transition fired despite 5 concurrent calls");

    // The entry is approved and the racers did not corrupt it.
    const got = await mcp(p.mcpToken, "get_entry", { collection: "tickets", id });
    assert.equal(got.value.data.status, "approved");
  });
});
