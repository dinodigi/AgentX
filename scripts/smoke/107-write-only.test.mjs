import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureServer,
  createEphemeralProject,
  mcp,
  delivery,
  sql,
  waitFor,
  startWebhookReceiver,
  startHookReceiver,
  randomUUID,
} from "./helpers.mjs";

// SEC-1 — the write-only field type. Wall item 0ceec805.
//
// A write-only field is written but NEVER returned by any read. Before it
// existed, a credential in an ordinary text field was plaintext on five surfaces
// at once, and missing ONE of them ships the leak while every other surface
// reports success.
//
// HOW THIS FILE IS WRITTEN, and why it matters more than usual:
//
// Every check is "the SENTINEL must NOT appear", asserted against the ENTIRE
// serialized response — not against `data.secret_hash`. Two reasons:
//
//   1. An omission is invisible to an assertion that only checks what should be
//      present. `assert.equal(row.data.title, "x")` passes just as happily on a
//      response that also carries the password.
//   2. Checking one key only proves the key I thought of is clean. Scanning the
//      whole JSON for a value that exists nowhere else in the fixture catches
//      leaks through paths I did not think to name — a sibling `related` block, a
//      `prevData`, an echoed hook envelope, a CSV column, an error message.
//
// The sentinel is a fresh uuid, so a match is never a coincidence.
//
// And there is a POSITIVE CONTROL (raw DB read) proving the value is actually
// STORED. Without it, a field that silently discarded every write would pass
// every single "must not appear" test in this file.

const SENTINEL = `SENTINEL-${randomUUID()}`;
const ROTATED = `ROTATED-${randomUUID()}`;

/** The whole point: the secret must not be anywhere in this payload. */
function assertNoLeak(label, value) {
  const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
  assert.ok(
    !json.includes(SENTINEL) && !json.includes(ROTATED),
    `LEAK on ${label}: a write-only value appeared in the response\n${json.slice(0, 1200)}`,
  );
}

describe("SEC-1 — a write-only field never appears in any read path", () => {
  let p;
  let hook;
  let webhook;
  let entryId;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("write-only");
    webhook = await startWebhookReceiver();
    hook = await startHookReceiver();

    const r = await mcp(p.mcpToken, "define_collection", {
      name: "accounts",
      fields: [
        { name: "email", label: "Email", type: "text", required: true, publicRead: true, searchable: true },
        { name: "plan", label: "Plan", type: "enum", options: ["free", "pro"], publicRead: true },
        // THE FIELD UNDER TEST.
        { name: "password_hash", label: "Password hash", type: "text", writeOnly: true, max: 255 },
        { name: "api_key", label: "BYO API key", type: "text", writeOnly: true },
      ],
      events: {
        created: [{ type: "webhook", url: webhook.url }],
        updated: [{ type: "webhook", url: webhook.url }],
      },
    });
    assert.ok(r.ok, r.errorText);

    const created = await mcp(p.mcpToken, "create_entry", {
      collection: "accounts",
      data: { email: "a@smoke.test", plan: "free", password_hash: SENTINEL },
    });
    assert.ok(created.ok, created.errorText);
    entryId = created.value.id;
    // The create RESPONSE is itself a read.
    assertNoLeak("create_entry response", created.value);
  });

  after(async () => {
    await webhook.close();
    await hook.close();
    await p.destroy();
  });

  // ── the positive control ─────────────────────────────────────────────────
  // Everything below asserts an absence. This is the one test that proves the
  // absences mean "hidden" and not "never written".

  it("POSITIVE CONTROL: the value IS stored — write-only is not write-nowhere", async () => {
    const [row] = await sql`SELECT data->>'password_hash' AS h FROM entries WHERE id = ${entryId}`;
    assert.equal(row.h, SENTINEL, "the whole feature is pointless if the write is discarded");
  });

  // ── surface by surface ───────────────────────────────────────────────────

  it("MCP get_entry must NOT contain it", async () => {
    const r = await mcp(p.mcpToken, "get_entry", { collection: "accounts", id: entryId });
    assert.ok(r.ok, r.errorText);
    assertNoLeak("get_entry", r.value);
    assert.ok(!("password_hash" in r.value.data), "the KEY must be absent, not blanked");
    assert.equal(r.value.data.email, "a@smoke.test", "…while the rest of the row reads normally");
  });

  it("MCP query_entries must NOT contain it", async () => {
    const r = await mcp(p.mcpToken, "query_entries", { collection: "accounts" });
    assert.ok(r.ok, r.errorText);
    assertNoLeak("query_entries", r.value);
  });

  it("MCP search_entries must NOT contain it", async () => {
    const r = await mcp(p.mcpToken, "search_entries", { collection: "accounts", q: "smoke" });
    assert.ok(r.ok, r.errorText);
    assertNoLeak("search_entries", r.value);
  });

  it("the DELIVERY API must NOT contain it — list and single", async () => {
    const list = await delivery(p.deliveryToken, "/accounts");
    assert.equal(list.status, 200);
    assertNoLeak("GET /v1/accounts", list.json);
    const one = await delivery(p.deliveryToken, `/accounts/${entryId}`);
    assert.equal(one.status, 200);
    assertNoLeak("GET /v1/accounts/:id", one.json);
  });

  it("EXPORT must NOT contain it — json rows, and the csv has no COLUMN for it", async () => {
    const json = await mcp(p.mcpToken, "export_entries", { collection: "accounts", format: "json" });
    assert.ok(json.ok, json.errorText);
    assertNoLeak("export_entries json", json.value);

    const csv = await mcp(p.mcpToken, "export_entries", { collection: "accounts", format: "csv" });
    assert.ok(csv.ok, csv.errorText);
    assertNoLeak("export_entries csv", csv.value);
    const header = csv.value.csv.split("\r\n")[0];
    assert.ok(!header.includes("password_hash"), `an empty column invites a re-import that fills it back in: ${header}`);
    assert.ok(header.includes("email"), "…other columns are still there");
  });

  // NOTE on the next two tests, learned by deliberately breaking the code they
  // cover: they pass even with READ-side redaction removed, because layer 1
  // (storage stripping) means the row never held the secret in the first place.
  // So they are honestly LAYER-1 tests — "the value was never copied here" — and
  // the read pass is what the flip suite at the bottom of this file exercises.
  // Naming that is the difference between a test and a test that looks like one.

  it("ENTRY VERSIONS (layer 1): the snapshot table never receives it", async () => {
    // An update captures a PRE-image, and that pre-image contained the secret.
    const up = await mcp(p.mcpToken, "update_entry", {
      collection: "accounts", id: entryId, data: { plan: "pro" },
    });
    assert.ok(up.ok, up.errorText);
    assertNoLeak("update_entry response", up.value);

    const versions = await waitFor(async () => {
      const r = await mcp(p.mcpToken, "list_entry_versions", { collection: "accounts", id: entryId });
      return r.ok && r.value.versions.length > 0 ? r.value : null;
    });
    assert.ok(versions, "expected a version snapshot after the update");
    assertNoLeak("list_entry_versions", versions);

    const rows = await sql`SELECT data FROM entry_versions WHERE entry_id = ${entryId}`;
    assert.ok(rows.length > 0, "expected snapshot rows");
    assertNoLeak("entry_versions TABLE", rows);
  });

  it("the CHANGES FEED (layer 1): 30 days of snapshots, and the row never receives it", async () => {
    const feed = await mcp(p.mcpToken, "get_changes", {});
    assert.ok(feed.ok, feed.errorText);
    assertNoLeak("get_changes", feed.value);

    const pub = await delivery(p.deliveryToken, "/changes");
    assert.equal(pub.status, 200);
    assertNoLeak("GET /v1/changes", pub.json);

    const rows = await sql`SELECT data, prev_data FROM entry_changes WHERE entry_id = ${entryId}`;
    assert.ok(rows.length > 0, "expected feed rows for this entry");
    assertNoLeak("entry_changes TABLE", rows);
  });

  it("the SSE change stream must NOT contain it", async () => {
    const res = await fetch(
      `${process.env.SMOKE_BASE ?? "http://localhost:3000"}/api/v1/changes/stream`,
      { headers: { authorization: `Bearer ${p.deliveryToken}` }, signal: AbortSignal.timeout(4000) },
    ).catch(() => null);
    if (!res || !res.ok) return; // stream unavailable in this environment — the /changes test above still gates
    const reader = res.body.getReader();
    let text = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      text += new TextDecoder().decode(value);
      if (text.includes("\n\n") && text.length > 200) break;
    }
    await reader.cancel().catch(() => {});
    assertNoLeak("GET /v1/changes/stream", text);
  });

  it("WEBHOOK payloads must NOT contain it — nor the delivery log that stores them", async () => {
    const got = await waitFor(() => (webhook.received.length > 0 ? webhook.received : null));
    assert.ok(got, "expected the created/updated webhook to fire");
    assertNoLeak("webhook payload", got);

    const log = await mcp(p.mcpToken, "get_deliveries", {});
    assert.ok(log.ok, log.errorText);
    assertNoLeak("get_deliveries", log.value);
    const rows = await sql`SELECT payload FROM webhook_deliveries WHERE project_id = ${p.id}`;
    assertNoLeak("webhook_deliveries table", rows);
  });

  it("WORKFLOW TRANSITION actions must NOT contain it — the third dispatch route", async () => {
    // Three callers reach runEventAction: immediate events, delayed jobs, and
    // transition actions. Redaction lives in that one shared exit point rather
    // than at each caller, and this is the caller with a DIFFERENT payload shape
    // (it carries a `transition` key), so it is the one most likely to have been
    // built by hand somewhere else.
    const sink = await startWebhookReceiver();
    try {
      const def = await mcp(p.mcpToken, "define_collection", {
        name: "gated",
        fields: [
          { name: "title", label: "T", type: "text", required: true, publicRead: true },
          { name: "api_key", label: "K", type: "text", writeOnly: true },
          { name: "stage", label: "S", type: "enum", options: ["draft", "live"] },
        ],
        workflow: {
          field: "stage",
          initial: "draft",
          transitions: [
            { from: "draft", to: "live", actors: ["mcp"], actions: [{ type: "webhook", url: sink.url }] },
          ],
        },
      });
      assert.ok(def.ok, def.errorText);
      const e = await mcp(p.mcpToken, "create_entry", {
        collection: "gated", data: { title: "shipping", api_key: SENTINEL },
      });
      assert.ok(e.ok, e.errorText);
      const move = await mcp(p.mcpToken, "update_entry", {
        collection: "gated", id: e.value.id, data: { stage: "live" },
      });
      assert.ok(move.ok, move.errorText);
      const got = await waitFor(() => (sink.received.length > 0 ? sink.received : null));
      assert.ok(got, "expected the transition action to fire");
      // Sanity: the payload really is the transition shape, so a pass here means
      // this route was exercised rather than skipped.
      assert.ok(got.some((x) => x.transition), "payload should carry the transition");
      assertNoLeak("transition action payload", got);
    } finally {
      await sink.close();
    }
  });

  it("the AUDIT LOG names the field but never its value — a rotation stays visible", async () => {
    const audit = await mcp(p.mcpToken, "get_audit_log", { entryId });
    assert.ok(audit.ok, audit.errorText);
    assertNoLeak("get_audit_log", audit.value);
  });

  it("TRASH must NOT contain it — including the admin's first-stringy-value preview", async () => {
    const doomed = await mcp(p.mcpToken, "create_entry", {
      collection: "accounts",
      // password_hash FIRST, so a naive "first stringy value" preview picks it.
      data: { password_hash: SENTINEL, email: "doomed@smoke.test" },
    });
    assert.ok(doomed.ok, doomed.errorText);
    await mcp(p.mcpToken, "delete_entry", { collection: "accounts", id: doomed.value.id });
    const trash = await mcp(p.mcpToken, "list_trash", {});
    assert.ok(trash.ok, trash.errorText);
    assertNoLeak("list_trash", trash.value);
  });

  it("TRANSACT results and the idempotency RECEIPT must NOT contain it", async () => {
    const key = `wo-${randomUUID()}`;
    const t = await mcp(p.mcpToken, "transact", {
      idempotencyKey: key,
      ops: [
        { op: "create", collection: "accounts", data: { email: "tx@smoke.test", password_hash: SENTINEL } },
        { op: "update", collection: "accounts", id: entryId, data: { api_key: SENTINEL } },
      ],
    });
    assert.ok(t.ok, t.errorText);
    assertNoLeak("transact result", t.value);
    const rows = await sql`SELECT results FROM transact_receipts WHERE idempotency_key = ${key}`;
    assertNoLeak("transact_receipts table", rows);
    // The replay path returns the STORED receipt — check that too.
    const replay = await mcp(p.mcpToken, "transact", {
      idempotencyKey: key,
      ops: [{ op: "create", collection: "accounts", data: { email: "tx@smoke.test" } }],
    });
    assert.ok(replay.ok, replay.errorText);
    assertNoLeak("transact replay", replay.value);
  });

  // ── update semantics: the silent-clear traps ─────────────────────────────

  it("an UPDATE that omits the field leaves the stored value alone", async () => {
    const r = await mcp(p.mcpToken, "update_entry", {
      collection: "accounts", id: entryId, data: { email: "renamed@smoke.test" },
    });
    assert.ok(r.ok, r.errorText);
    const [row] = await sql`SELECT data->>'password_hash' AS h FROM entries WHERE id = ${entryId}`;
    assert.equal(row.h, SENTINEL, "silently clearing a credential on a partial update would be catastrophic");
  });

  it("a new value ROTATES it; explicit null UNSETS it", async () => {
    const rot = await mcp(p.mcpToken, "update_entry", {
      collection: "accounts", id: entryId, data: { password_hash: ROTATED },
    });
    assert.ok(rot.ok, rot.errorText);
    assertNoLeak("rotate response", rot.value);
    let [row] = await sql`SELECT data->>'password_hash' AS h FROM entries WHERE id = ${entryId}`;
    assert.equal(row.h, ROTATED);

    const unset = await mcp(p.mcpToken, "update_entry", {
      collection: "accounts", id: entryId, data: { password_hash: null },
    });
    assert.ok(unset.ok, unset.errorText);
    [row] = await sql`SELECT jsonb_exists(data, 'password_hash') AS present FROM entries WHERE id = ${entryId}`;
    assert.equal(row.present, false, "null is the documented explicit unset");

    // Put it back for the restore test below.
    await mcp(p.mcpToken, "update_entry", {
      collection: "accounts", id: entryId, data: { password_hash: ROTATED },
    });
  });

  it("RESTORING a version does not clear the credential — the snapshot never had it", async () => {
    const list = await mcp(p.mcpToken, "list_entry_versions", { collection: "accounts", id: entryId });
    assert.ok(list.ok && list.value.versions.length > 0, list.errorText);
    const versionId = list.value.versions[0].versionId;
    const r = await mcp(p.mcpToken, "restore_entry_version", {
      collection: "accounts", id: entryId, versionId,
    });
    assert.ok(r.ok, r.errorText);
    assertNoLeak("restore_entry_version", r.value);
    const [row] = await sql`SELECT data->>'password_hash' AS h FROM entries WHERE id = ${entryId}`;
    assert.equal(
      row.h,
      ROTATED,
      "a restore writes the FULL snapshot; without carrying write-only values across it would wipe the credential and report success",
    );
  });

  // ── before-write hooks: an external endpoint is a read path ──────────────

  it("HOOK envelopes must NOT contain it, and a hook transform cannot clear it", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "accounts",
      fields: [
        { name: "email", label: "Email", type: "text", required: true, publicRead: true, searchable: true },
        { name: "plan", label: "Plan", type: "enum", options: ["free", "pro"], publicRead: true },
        { name: "password_hash", label: "Password hash", type: "text", writeOnly: true, max: 255 },
        { name: "api_key", label: "BYO API key", type: "text", writeOnly: true },
      ],
      hooks: {
        beforeCreate: { url: hook.url, mode: "transform" },
        beforeUpdate: { url: hook.url, mode: "transform" },
      },
      confirm: true,
    });
    assert.ok(r.ok, r.errorText);

    hook.approve();
    const created = await mcp(p.mcpToken, "create_entry", {
      collection: "accounts",
      data: { email: "hooked@smoke.test", password_hash: SENTINEL },
    });
    assert.ok(created.ok, created.errorText);
    const envelopes = await waitFor(() => (hook.received.length > 0 ? hook.received : null));
    assert.ok(envelopes, "expected the beforeCreate hook to be consulted");
    assertNoLeak("beforeCreate envelope", envelopes.map((e) => e.body).join("\n"));
    // ...and the value still landed, even though the hook never saw it.
    const [row] = await sql`SELECT data->>'password_hash' AS h FROM entries WHERE id = ${created.value.id}`;
    assert.equal(row.h, SENTINEL, "redacting the envelope must not drop the write");

    // A TRANSFORM replaces the whole row. It cannot see the credential, so
    // without preservation the replace-patch would null it out.
    hook.transform({ email: "transformed@smoke.test", plan: "pro" });
    const up = await mcp(p.mcpToken, "update_entry", {
      collection: "accounts", id: created.value.id, data: { plan: "pro" },
    });
    assert.ok(up.ok, up.errorText);
    const [after] = await sql`SELECT data->>'password_hash' AS h, data->>'email' AS e
      FROM entries WHERE id = ${created.value.id}`;
    assert.equal(after.e, "transformed@smoke.test", "the transform did apply");
    assert.equal(after.h, SENTINEL, "a hook that cannot read the credential must not be able to erase it");

    // A rotation THROUGH a transform keeps the caller's new value.
    hook.transform({ email: "rotated@smoke.test" });
    const rot = await mcp(p.mcpToken, "update_entry", {
      collection: "accounts", id: created.value.id, data: { password_hash: ROTATED },
    });
    assert.ok(rot.ok, rot.errorText);
    const [rotated] = await sql`SELECT data->>'password_hash' AS h FROM entries WHERE id = ${created.value.id}`;
    assert.equal(rotated.h, ROTATED, "the caller's rotation is authoritative over the frozen current value");

    hook.approve();
    const test = await mcp(p.mcpToken, "test_hook", {
      collection: "accounts",
      stage: "beforeCreate",
      data: { email: "dry@smoke.test", password_hash: SENTINEL },
    });
    assert.ok(test.ok, test.errorText);
    assertNoLeak("test_hook", test.value);
  });

  // ── reads through the side door ──────────────────────────────────────────

  it("a FILTER or SORT on it is refused — an eq/contains probe is a read", async () => {
    for (const where of [
      [{ field: "password_hash", op: "eq", value: SENTINEL }],
      [{ field: "password_hash", op: "contains", value: "SENT" }],
      [{ field: "password_hash", op: "exists", value: true }],
    ]) {
      const r = await mcp(p.mcpToken, "query_entries", { collection: "accounts", where });
      assert.equal(r.ok, false, `where ${where[0].op} on a write-only field must be refused`);
      assert.match(r.errorText, /write-only/);
    }
    const sorted = await mcp(p.mcpToken, "query_entries", {
      collection: "accounts", orderBy: { field: "password_hash", dir: "asc" },
    });
    assert.equal(sorted.ok, false, "sorting leaks the ordering");
    assert.match(sorted.errorText, /write-only/);
  });

  it("naming it in SELECT is refused, not silently dropped", async () => {
    const r = await mcp(p.mcpToken, "query_entries", {
      collection: "accounts", select: ["email", "password_hash"],
    });
    assert.equal(r.ok, false, "silently dropping it would teach an agent the value is unset");
    assert.match(r.errorText, /write-only/);
  });

  it("an update_entry_if CONDITION on it is refused — the CAS path is not a probe", async () => {
    const r = await mcp(p.mcpToken, "update_entry_if", {
      collection: "accounts",
      id: entryId,
      if: [{ field: "password_hash", op: "eq", value: SENTINEL }],
      data: { plan: "free" },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /write-only/);
  });

  it("a DELIVERY filter on it is refused too", async () => {
    const r = await delivery(p.deliveryToken, `/accounts?password_hash=${SENTINEL}`);
    assert.ok(r.status >= 400, `the public surface must not accept a probe either (got ${r.status})`);
    assertNoLeak("delivery filter attempt", r.json);
  });

  it("describe_collection DOES report that the field exists and is write-only", async () => {
    // Hiding its existence would make the schema unexplainable: an agent writes a
    // password, reads the row back, sees nothing, and concludes the write failed.
    const r = await mcp(p.mcpToken, "describe_collection", { name: "accounts" });
    assert.ok(r.ok, r.errorText);
    const f = r.value.fields.find((x) => x.name === "password_hash");
    assert.ok(f, "the field must be listed");
    assert.equal(f.writeOnly, true);
    assert.deepEqual(r.value.writeOnlyFields.sort(), ["api_key", "password_hash"]);
    assert.match(r.value.writeOnlyNote, /never returned by any read/);
    assertNoLeak("describe_collection", r.value);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-1 — flipping an EXISTING field to write-only redacts its history", () => {
  // The case that makes read-time redaction load-bearing rather than
  // belt-and-braces: history written while the field was ordinary text is
  // plaintext in version snapshots, feed rows, and delivery logs. Storage
  // stripping cannot retroactively fix those; the read pass must.
  let p;
  let id;
  let hookSink;
  const OLD = `SENTINEL-${randomUUID()}`;

  const noOld = (label, v) => {
    const json = typeof v === "string" ? v : JSON.stringify(v ?? null);
    assert.ok(!json.includes(OLD), `LEAK on ${label} after the flip:\n${json.slice(0, 1200)}`);
  };

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("write-only-flip");
    // A webhook, so the DELIVERY LOG also captures the plaintext before the flip.
    // Without it the get_deliveries test below passes vacuously — which is what
    // happened the first time, and is exactly the failure mode this file is about.
    hookSink = await startWebhookReceiver();
    const defined = await mcp(p.mcpToken, "define_collection", {
      name: "keys",
      fields: [
        { name: "label", label: "Label", type: "text", required: true, publicRead: true },
        // Ordinary, PUBLIC text field to begin with — the worst starting point.
        { name: "token", label: "Token", type: "text", publicRead: true },
      ],
      events: { created: [{ type: "webhook", url: hookSink.url }] },
    });
    assert.ok(defined.ok, defined.errorText);
    const created = await mcp(p.mcpToken, "create_entry", {
      collection: "keys", data: { label: "legacy", token: OLD },
    });
    id = created.value.id;
    await waitFor(async () => {
      const r = await sql`SELECT count(*)::int AS n FROM webhook_deliveries
        WHERE project_id = ${p.id} AND payload::text LIKE ${"%" + OLD + "%"}`;
      return r[0].n > 0 ? r : null;
    });
    // An update, so a version snapshot AND a prevData feed row both capture it.
    await mcp(p.mcpToken, "update_entry", { collection: "keys", id, data: { label: "legacy v2" } });
    await waitFor(async () => {
      const r = await sql`SELECT count(*)::int AS n FROM entry_versions WHERE entry_id = ${id}`;
      return r[0].n > 0 ? r : null;
    });
    // A second row, deleted, so list_trash has something to redact.
    const doomed = await mcp(p.mcpToken, "create_entry", {
      collection: "keys", data: { token: OLD, label: "trashed" },
    });
    await mcp(p.mcpToken, "delete_entry", { collection: "keys", id: doomed.value.id });

    // THE FLIP. publicRead has to go: writeOnly + publicRead is a contradiction
    // (asserted below), which is itself part of the story — you cannot make a
    // published field write-only without also unpublishing it.
    const flip = await mcp(p.mcpToken, "define_collection", {
      name: "keys",
      fields: [
        { name: "label", label: "Label", type: "text", required: true, publicRead: true },
        { name: "token", label: "Token", type: "text", writeOnly: true },
      ],
      confirm: true,
    });
    assert.ok(flip.ok, flip.errorText);
  });
  after(async () => {
    await hookSink.close();
    await p.destroy();
  });

  it("FIXTURE: the archive still holds the plaintext — so each test below really is a read test", async () => {
    // This is the negative control for the whole suite. If layer 1 had somehow
    // scrubbed the archive, every assertion below would pass without the read
    // pass doing anything at all — which is how a redaction test quietly stops
    // testing redaction.
    const v = await sql`SELECT data FROM entry_versions WHERE entry_id = ${id}`;
    assert.ok(JSON.stringify(v).includes(OLD), "the version snapshot must still contain it");
    const c = await sql`SELECT data, prev_data FROM entry_changes WHERE entry_id = ${id}`;
    assert.ok(JSON.stringify(c).includes(OLD), "the feed row must still contain it");
    const t = await sql`SELECT data FROM entries_trash WHERE project_id = ${p.id}`;
    assert.ok(JSON.stringify(t).includes(OLD), "the trashed row must still contain it");
    const d = await sql`SELECT payload FROM webhook_deliveries WHERE project_id = ${p.id}`;
    assert.ok(JSON.stringify(d).includes(OLD), "the delivery log must still contain it");
  });

  it("writeOnly + publicRead is refused — a published field cannot stay published", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "keys",
      fields: [
        { name: "label", label: "Label", type: "text", required: true, publicRead: true },
        { name: "token", label: "Token", type: "text", publicRead: true, writeOnly: true },
      ],
      confirm: true,
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /publicRead/);
  });

  // One test per surface: a failure names the surface, and no surface can hide
  // behind another's pass.
  const mcpSurfaces = [
    ["get_entry", () => ({ collection: "keys", id })],
    ["query_entries", () => ({ collection: "keys" })],
    ["export_entries json", () => ({ collection: "keys", format: "json" }), "export_entries"],
    ["export_entries csv", () => ({ collection: "keys", format: "csv" }), "export_entries"],
    ["list_entry_versions", () => ({ collection: "keys", id })],
    ["get_changes", () => ({})],
    ["list_trash", () => ({})],
    ["get_deliveries", () => ({})],
  ];
  for (const [label, args, toolName] of mcpSurfaces) {
    it(`${label} redacts the pre-existing value`, async () => {
      const r = await mcp(p.mcpToken, toolName ?? label, args());
      assert.ok(r.ok, r.errorText);
      noOld(label, r.value);
    });
  }

  it("the delivery API redacts the pre-existing value — list, single, and changes", async () => {
    const list = await delivery(p.deliveryToken, "/keys");
    assert.equal(list.status, 200);
    noOld("GET /v1/keys", list.json);
    const one = await delivery(p.deliveryToken, `/keys/${id}`);
    noOld("GET /v1/keys/:id", one.json);
    const chg = await delivery(p.deliveryToken, "/changes");
    noOld("GET /v1/changes", chg.json);
  });

  it("...and the archive is still untouched — redaction on READ, not a data migration", async () => {
    // Deliberately NOT a destructive rewrite of history: flipping a flag must
    // not silently delete data, and a flag flipped back by mistake should not
    // have cost the tenant their column. The reads are what changed.
    const raw = await sql`SELECT data FROM entry_versions WHERE entry_id = ${id}`;
    assert.ok(JSON.stringify(raw).includes(OLD));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-1 — define-time refusals", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("write-only-define");
  });
  after(() => p.destroy());

  const define = (name, fields, extra = {}) =>
    mcp(p.mcpToken, "define_collection", { name, fields, ...extra });

  const base = { name: "label", label: "L", type: "text", required: true };

  it("writeOnly is refused on every type but text", async () => {
    for (const type of ["number", "boolean", "date", "asset", "richtext"]) {
      const r = await define(`wo_${type}`, [base, { name: "x", label: "X", type, writeOnly: true }]);
      assert.equal(r.ok, false, `${type} must be refused`);
      assert.match(r.errorText, /writeOnly is only valid on a text field/);
    }
  });

  it("every knob that would serve the value, or make it an oracle, is refused with its reason", async () => {
    const cases = [
      ["publicRead", { publicRead: true }],
      ["unique", { unique: true }],
      ["capacity", { capacity: 5 }],
      ["indexed", { indexed: true }],
      ["searchable", { searchable: true }],
      ["localized", { localized: true }],
      ["computed", { computed: { fn: "uuid" } }],
    ];
    for (const [knob, extra] of cases) {
      const r = await define(`wo_knob_${knob.toLowerCase()}`, [
        base,
        { name: "secret", label: "S", type: "text", writeOnly: true, ...extra },
      ]);
      assert.equal(r.ok, false, `writeOnly + ${knob} must be refused`);
      assert.match(r.errorText, new RegExp(knob), `the refusal must name the knob: ${r.errorText}`);
    }
  });

  it("a computed field may not derive FROM a write-only field — that is laundering", async () => {
    const r = await define("wo_launder", [
      base,
      { name: "secret", label: "S", type: "text", writeOnly: true },
      { name: "leak", label: "Leak", type: "text", computed: { fn: "template", template: "{{secret}}" } },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.errorText, /write-only/);
  });

  it("writeOnly is refused INSIDE a group or array — the guarantee stays flat", async () => {
    const r = await define("wo_nested", [
      base,
      {
        name: "creds", label: "Creds", type: "group",
        fields: [{ name: "secret", label: "S", type: "text", writeOnly: true }],
      },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.errorText, /TOP-LEVEL|top-level/);
  });

  it("a publicFilter or an event `when` naming it is refused at DEFINE time", async () => {
    const fields = [base, { name: "secret", label: "S", type: "text", writeOnly: true }];
    const pf = await define("wo_pf", fields, {
      publicFilter: [{ field: "secret", op: "exists", value: true }],
    });
    assert.equal(pf.ok, false);
    assert.match(pf.errorText, /write-only/);

    const ev = await define("wo_when", fields, {
      events: { created: [{ type: "webhook", url: "https://example.test/h", when: [{ field: "secret", op: "exists", value: true }] }] },
    });
    assert.equal(ev.ok, false);
    assert.match(ev.errorText, /write-only/);
  });

  it("an email template referencing it is refused — an email is a read with a recipient", async () => {
    const r = await define("wo_email", [base, { name: "secret", label: "S", type: "text", writeOnly: true }], {
      events: {
        created: [{ type: "email", to: "ops@smoke.test", subject: "key {{secret}}", body: "x" }],
      },
    });
    assert.equal(r.ok, false);
    // Specifically the write-only refusal — this project has no email provider
    // either, and a provider error passing for a security gate is exactly the
    // kind of "passes for the wrong reason" this file exists to avoid.
    assert.match(r.errorText, /write-only/);
  });

  it("access.ownerField / access.org.field cannot be write-only — gated reads compare them", async () => {
    const r = await define("wo_owner", [base, { name: "owner", label: "O", type: "text", writeOnly: true }], {
      access: { read: "owner", write: "owner", ownerField: "owner" },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /write-only/);
  });

  it("a relation may not point its labelField at a write-only field — BOTH directions", async () => {
    const ok1 = await define("wo_targets", [
      base,
      { name: "secret", label: "S", type: "text", writeOnly: true },
    ]);
    assert.ok(ok1.ok, ok1.errorText);

    // (a) defining the relation at a write-only label
    const rel = await define("wo_parents", [
      base,
      { name: "t", label: "T", type: "relation", targetCollection: "wo_targets", labelField: "secret" },
    ]);
    assert.equal(rel.ok, false, "the {id,label} channel resolves the label on every parent read");
    assert.match(rel.errorText, /write-only/);

    // (b) flipping a field that is ALREADY an inbound labelField
    const ok2 = await define("wo_parents", [
      base,
      { name: "t", label: "T", type: "relation", targetCollection: "wo_targets", labelField: "label" },
    ]);
    assert.ok(ok2.ok, ok2.errorText);
    const flip = await define("wo_targets", [
      { name: "label", label: "L", type: "text", required: true, writeOnly: true },
      { name: "secret", label: "S", type: "text", writeOnly: true },
    ], { confirm: true });
    assert.equal(flip.ok, false, "otherwise (a) is violated retroactively by editing the target");
    assert.match(flip.errorText, /write-only/);
  });

  it("a schedule's set.copyFrom cannot SOURCE it — copying is laundering, same as a computed template", async () => {
    // Found by sweeping every place a caller-supplied field NAME is used to read a
    // value, rather than by reasoning about read paths: the mutate sweep's
    // copyFrom only checked that the field EXISTS, so it would have copied a
    // write-only value into an ordinary field that never declared itself secret.
    const ok = await define("wo_sweepable", [
      base,
      { name: "secret", label: "S", type: "text", writeOnly: true },
      { name: "copy", label: "C", type: "text" },
      { name: "stage", label: "St", type: "enum", options: ["a", "b"] },
    ]);
    assert.ok(ok.ok, ok.errorText);
    const r = await mcp(p.mcpToken, "define_schedule", {
      name: "wo_launder_sweep",
      recurrence: { frequency: "daily", at: "03:00" },
      action: {
        type: "mutate",
        collection: "wo_sweepable",
        where: [{ field: "stage", op: "eq", value: "a" }],
        set: { copy: { copyFrom: "secret" } },
      },
    });
    assert.equal(r.ok, false, "a sweep must not be able to move a write-only value into a readable field");
    assert.match(r.errorText, /WRITE-ONLY|write-only/);
  });

  it("a schedule's where clause cannot FILTER on it either", async () => {
    const r = await mcp(p.mcpToken, "define_schedule", {
      name: "wo_probe_sweep",
      recurrence: { frequency: "daily", at: "03:00" },
      action: {
        type: "mutate",
        collection: "wo_sweepable",
        where: [{ field: "secret", op: "exists", value: true }],
        set: { copy: { value: "x" } },
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /write-only/, "must fail on the FIELD gate, not on some unrelated validation");
  });

  it("a checkout priceField cannot be write-only — the checkout route reads it", async () => {
    const r = await define("wo_products", [base, { name: "price_id", label: "P", type: "text", writeOnly: true }], {
      checkout: { priceField: "price_id", successUrl: "https://a.test/s", cancelUrl: "https://a.test/c" },
    });
    assert.equal(r.ok, false);
    assert.match(r.errorText, /write-only/, "not the missing-connector error — the field gate must fire first");
  });
});
