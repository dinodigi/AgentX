import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

// CONTRACT-1 — the agent-facing language pass.
//
// Same contract as suite 108: read the live surface the way an agent does
// (tools/list + get_project_info + list_field_types), assert the corrected
// words, and where the claim is BEHAVIORAL pin it to the wire in the same file.
// A description that merely reads well is how WP-3's lie survived for months.
//
// 114a — the FIELD + QUERY vocabulary. Every defect here was a shipped
// capability the contract kept invisible or mis-enumerated:
//   · list_field_types said "the 8 field primitives" and named 8 while
//     RETURNING 10 — group/array shipped in DM-1 and never reached the words.
//   · capacity (DM-3, bea3377) appeared in the payload ONLY inside writeOnly's
//     incompatibility list: the word with no definition anywhere.
//   · query_entries/aggregate_entries enumerated 7 of the 9 real ops, omitting
//     the two an exclusion filter and an array filter actually need.

describe("CONTRACT-1 — field + query vocabulary matches the wire", () => {
  let p;
  let tools;
  let fieldTypes;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("contract-lang");
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = await res.json();
    assert.ok(body.result?.tools?.length > 0, "tools/list must answer");
    tools = new Map(body.result.tools.map((t) => [t.name, t]));
    const r = await mcp(p.mcpToken, "list_field_types", {});
    assert.ok(r.ok, r.errorText);
    fieldTypes = r.value;
  });
  after(() => p.destroy());

  it("the primitive COUNT in the description equals what the tool returns, and the containers are named", () => {
    const desc = tools.get("list_field_types").description;
    const actual = Object.keys(fieldTypes.types);
    // The bug this replaces: a hard-coded "8" that stayed 8 across DM-1.
    assert.match(
      desc,
      new RegExp(`\\b${actual.length} field primitives\\b`),
      `description must say "${actual.length} field primitives" — it returns ${actual.length}: ${actual.join(", ")}`,
    );
    // …and EVERY returned type must be named in the description. This is the
    // assertion that cannot rot: add an 11th primitive and it fails until the
    // words follow.
    for (const t of actual) {
      assert.ok(desc.includes(t), `type "${t}" is returned by list_field_types but not named in its description`);
    }
    // The containers specifically — they are what an agent needs to know EXISTS
    // before it flattens a repeater into 5 numbered text fields.
    assert.match(desc, /group/);
    assert.match(desc, /array/);
  });

  it("FIXTURE CHECK: the description does not still claim 8 — the exact stale number is pinned out", () => {
    // Negative control for the assertion above: without this, changing the
    // regex source would let "8 field primitives" back in silently.
    const desc = tools.get("list_field_types").description;
    assert.ok(
      !/\b8 field primitives\b/.test(desc),
      "the pre-CONTRACT-1 count is back — group and array are invisible again",
    );
  });

  it("capacity is DEFINED in commonConfig, not just mentioned as an incompatibility", () => {
    const common = fieldTypes.commonConfig;
    assert.ok(Array.isArray(common), "list_field_types must return commonConfig");
    const entry = common.find((c) => c.startsWith("capacity?:"));
    assert.ok(
      entry,
      "capacity has no commonConfig entry — before this fix the ONLY occurrence of the word " +
        "in the whole payload was inside writeOnly's incompatibility list, which teaches nothing",
    );
    assert.match(entry, /AT MOST N/, "the semantic must be stated: unique is 1, capacity is N");
    assert.match(entry, /unique/, "the unique conflict is the first thing a modeler trips on");
    // The race argument is WHY this is a platform primitive rather than app code.
    assert.match(entry, /count-then-insert/);
  });

  it("BEHAVIORAL PIN: capacity:2 admits exactly 2 and refuses the 3rd, naming the remedy", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "seats",
      fields: [
        { name: "slot", label: "Slot", type: "text", capacity: 2 },
        { name: "who", label: "Who", type: "text", required: true },
      ],
    });
    assert.ok(def.ok, def.errorText);
    for (const who of ["a", "b"]) {
      const r = await mcp(p.mcpToken, "create_entry", { collection: "seats", data: { slot: "9am", who } });
      assert.ok(r.ok, `booking ${who} should fit under capacity 2: ${r.errorText}`);
    }
    const third = await mcp(p.mcpToken, "create_entry", { collection: "seats", data: { slot: "9am", who: "c" } });
    assert.ok(!third.ok, "the 3rd booking must be refused — capacity:2 is the whole claim");
    // Assert the REASON, never just failure (negative-control discipline): a
    // required-field or unknown-field error would otherwise pass this test.
    assert.match(third.errorText, /E_VALIDATION/);
    assert.match(third.errorText, /full|capacity/i, `the refusal must say why: ${third.errorText}`);
    assert.match(third.errorText, /at most 2/, "the limit is named, so the fix needs no second call");
    // Positive control: a DIFFERENT key is unaffected — the constraint is
    // per-value, not per-collection.
    const other = await mcp(p.mcpToken, "create_entry", { collection: "seats", data: { slot: "10am", who: "c" } });
    assert.ok(other.ok, `capacity is per-KEY; a different slot must still admit writes: ${other.errorText}`);
  });

  it("BEHAVIORAL PIN: a cancellation frees a seat — the commonConfig claim about trashed rows", async () => {
    // The claim in commonConfig is that the count is of LIVE rows. That is only
    // true because delete_entry MOVES the row to entries_trash rather than
    // flagging it in place — a soft-delete column would have made the sentence
    // false. Verified here rather than by reading the trigger.
    const list = await mcp(p.mcpToken, "query_entries", {
      collection: "seats",
      where: [{ field: "slot", op: "eq", value: "9am" }],
    });
    assert.ok(list.ok, list.errorText);
    assert.equal(list.value.entries.length, 2, "fixture: the 9am slot is full");
    const del = await mcp(p.mcpToken, "delete_entry", { collection: "seats", id: list.value.entries[0].id });
    assert.ok(del.ok, del.errorText);
    const refill = await mcp(p.mcpToken, "create_entry", { collection: "seats", data: { slot: "9am", who: "d" } });
    assert.ok(
      refill.ok,
      `a cancelled booking must free its seat — commonConfig says so: ${refill.errorText}`,
    );
  });

  it("the where-op enumerations in prose match WHERE_OPS exactly — no op is invisible", () => {
    // The ops live in lib/query.ts; the JSON schema derives from it, but the
    // DESCRIPTIONS were hand-typed and drifted. Read the real list from the
    // schema the same tool serves, then demand the prose covers it.
    const schemaOps = tools.get("query_entries").inputSchema.properties.where.items.oneOf[0].properties.op.enum;
    assert.ok(schemaOps.length >= 9, `expected the full op set, got ${schemaOps.join("|")}`);
    for (const name of ["query_entries", "aggregate_entries"]) {
      const desc = tools.get(name).description;
      for (const op of schemaOps) {
        assert.ok(
          new RegExp(`\\b${op}\\b`).test(desc),
          `${name}'s description omits op "${op}" — an agent that reads only the description cannot reach it`,
        );
      }
    }
  });

  it("BEHAVIORAL PIN: the two newly-listed ops really work (has + neOrUnset)", async () => {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "ops_check",
      fields: [
        { name: "title", label: "T", type: "text", required: true },
        { name: "tags", label: "Tags", type: "array", item: { type: "text" } },
        { name: "opted_out", label: "O", type: "boolean" },
      ],
    });
    assert.ok(def.ok, def.errorText);
    await mcp(p.mcpToken, "create_entry", {
      collection: "ops_check",
      data: { title: "tagged+optout", tags: ["rust", "go"], opted_out: true },
    });
    await mcp(p.mcpToken, "create_entry", { collection: "ops_check", data: { title: "unset-flag", tags: ["rust"] } });

    const has = await mcp(p.mcpToken, "query_entries", {
      collection: "ops_check",
      where: [{ field: "tags", op: "has", value: "go" }],
    });
    assert.ok(has.ok, has.errorText);
    assert.equal(has.value.entries.length, 1, "has = array membership");

    // The point of documenting neOrUnset: `ne` silently drops the unset row.
    const ne = await mcp(p.mcpToken, "query_entries", {
      collection: "ops_check",
      where: [{ field: "opted_out", op: "ne", value: true }],
    });
    assert.ok(ne.ok, ne.errorText);
    assert.equal(ne.value.entries.length, 0, "ne is SET-and-different — this is the trap the words now warn about");
    const nou = await mcp(p.mcpToken, "query_entries", {
      collection: "ops_check",
      where: [{ field: "opted_out", op: "neOrUnset", value: true }],
    });
    assert.ok(nou.ok, nou.errorText);
    assert.equal(nou.value.entries.length, 1, "neOrUnset keeps the never-set row — what an exclusion filter means");
  });

  it("upload_asset REDIRECTS end-user uploads to the delivery endpoint instead of the client-credential anti-pattern", () => {
    // The dogfood failure this closes: an agent found upload_asset (MCP), tried
    // to use it from a web app, and reached for keys-in-the-browser. The
    // delivery endpoint was documented — one blob away, in a key the agent never
    // opened. So the redirect goes where the confusion happens.
    const desc = tools.get("upload_asset").description;
    assert.match(desc, /\/uploads/, "must name the delivery uploads endpoint");
    assert.match(desc, /DELIVERY token/, "…and which credential it takes");
    assert.match(desc, /never reach a browser|must never reach a browser/, "…and why not this tool");
  });

  it("describe_collection's description covers everything it RETURNS", async () => {
    // It said "field definitions and flags" while returning publicFilter,
    // access, events, workflow, checkout and hooks. That undersell matters
    // because define_collection with `fields` is DECLARATIVE — an agent that
    // does not know describe_collection surfaces the workflow will re-send a
    // definition without it and silently drop the state machine.
    const p2 = await createEphemeralProject("describe-desc");
    try {
      const def = await mcp(p2.mcpToken, "define_collection", {
        name: "tickets",
        publicWrite: true,
        fields: [
          { name: "state", label: "S", type: "enum", options: ["open", "closed"] },
          { name: "title", label: "T", type: "text", required: true, publicRead: true },
        ],
        workflow: { field: "state", initial: "open", transitions: [{ from: "open", to: "closed" }] },
      });
      assert.ok(def.ok, def.errorText);
      const d = await mcp(p2.mcpToken, "describe_collection", { name: "tickets" });
      assert.ok(d.ok, d.errorText);
      const desc = tools.get("describe_collection").description;
      // Every top-level key it really returns must be named in the words.
      for (const key of Object.keys(d.value)) {
        if (["name", "displayName", "writeOnlyFields"].includes(key)) continue;
        assert.ok(
          desc.includes(key),
          `describe_collection returns "${key}" but its description never mentions it`,
        );
      }
      // The declarative-drop warning is the reason this matters at all.
      assert.match(desc, /DROPPED/);
      assert.ok(d.value.workflow, "fixture sanity: the workflow really is returned");
    } finally {
      await p2.destroy();
    }
  });

  it("BOUNDARY-HONEST: import_project says it carries NO entries, and really doesn't", async () => {
    const src = await createEphemeralProject("manifest-src");
    const dst = await createEphemeralProject("manifest-dst");
    try {
      const def = await mcp(src.mcpToken, "define_collection", {
        name: "notes",
        fields: [{ name: "body", label: "B", type: "text", required: true, publicRead: true }],
      });
      assert.ok(def.ok, def.errorText);
      const c = await mcp(src.mcpToken, "create_entry", { collection: "notes", data: { body: "content" } });
      assert.ok(c.ok, c.errorText);

      const desc = tools.get("import_project").description;
      assert.match(desc, /SCHEMA ONLY/, "the boundary must be stated where an agent plans a migration");
      assert.match(desc, /NO ENTRIES/);
      assert.match(desc, /export_entries/, "…and the interim path is named");
      assert.match(desc, /QRY-4/, "…and it cites the row, matching the notSupported registry");

      // BEHAVIORAL PIN: round-trip the manifest and prove the target has the
      // collection and ZERO rows. If import ever gains content this fails,
      // which is correct — the words would need to change with it.
      const ex = await mcp(src.mcpToken, "export_project", {});
      assert.ok(ex.ok, ex.errorText);
      const im = await mcp(dst.mcpToken, "import_project", { manifest: ex.value });
      assert.ok(im.ok, im.errorText);
      const cols = await mcp(dst.mcpToken, "list_collections", {});
      assert.ok(
        cols.value.some((x) => x.name === "notes"),
        "the SHAPE must arrive — positive control, so the empty count below means something",
      );
      const n = await mcp(dst.mcpToken, "count_entries", { collection: "notes" });
      assert.ok(n.ok, n.errorText);
      assert.equal(n.value.count ?? n.value, 0, "import_project must not carry entries");
    } finally {
      await src.destroy();
      await dst.destroy();
    }
  });

  it("SELF-CHECK: FIELD_TYPES in the source and the served payload agree", () => {
    // Cheap guard against the reverse drift — a primitive added to the type
    // union but never given a spec would serve a payload missing a key.
    const src = readFileSync("lib/field-types.ts", "utf8");
    const block = /export const FIELD_TYPES = \[([\s\S]*?)\] as const;/.exec(src);
    assert.ok(block, "could not read FIELD_TYPES");
    const declared = [...block[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      Object.keys(fieldTypes.types).sort(),
      declared.sort(),
      "every declared primitive needs a FIELD_TYPE_SPECS entry, and vice versa",
    );
  });
});

// 114b — the ORIENTATION BLOB. Three defect classes, all in get_project_info:
//   · an outright contradiction (writeBack told agents to use idempotencyKey
//     "through the delivery API", which has none — briefing.notSupported says so
//     in the SAME payload). This is WP-3's shape, one blob over.
//   · absent capabilities: event-webhook signing (WP-6 doc half), the
//     browser-safe read-only token (D3), the write-visibility convergence rule.
//   · the structural fix: `answers`, a routing table, because the uploads miss
//     was "documented where I didn't look", not "undocumented".
describe("CONTRACT-1 — the orientation blob answers the questions agents ask", () => {
  let p;
  let info;

  /** Resolve a dotted path against the payload — the same read `answers` promises. */
  const at = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), info);

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("contract-orient");
    const r = await mcp(p.mcpToken, "get_project_info", {});
    assert.ok(r.ok, r.errorText);
    info = r.value;
  });
  after(() => p.destroy());

  it("SELF-CHECK: every `answers` pointer resolves to real content in the SAME response", () => {
    assert.ok(Array.isArray(info.answers) && info.answers.length >= 10, "answers must be served");
    for (const a of info.answers) {
      assert.ok(a.q?.endsWith("?") || a.q?.length > 20, `each entry states a real question: ${a.q}`);
      const target = at(a.see);
      // The whole value of an index is that it lands somewhere. A dangling
      // pointer is worse than no index — it reads as a promise.
      assert.ok(
        target !== undefined && target !== null,
        `answers["${a.q}"] points at "${a.see}", which does not exist in get_project_info`,
      );
      if (typeof target === "string") {
        assert.ok(target.length > 40, `"${a.see}" resolves to a stub, not an answer`);
      } else {
        assert.ok(
          Array.isArray(target) ? target.length > 0 : Object.keys(target).length > 0,
          `"${a.see}" resolves to something empty`,
        );
      }
    }
  });

  it("SELF-CHECK: every tool named by `answers` exists on this surface", async () => {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const names = new Set((await res.json()).result.tools.map((t) => t.name));
    for (const a of info.answers) {
      if (!a.tool) continue;
      assert.ok(names.has(a.tool), `answers names tool "${a.tool}", which is not in tools/list`);
    }
  });

  it("the questions the FIELD failures were about are each covered", () => {
    // Not a taste test — every item here is a recorded miss (dogfood uploads,
    // jabed's convergence hunt, the 404-vs-auth report, WP-6, D3, QRY-3).
    const qs = info.answers.map((a) => a.q.toLowerCase()).join(" | ");
    for (const topic of ["upload", "token", "429", "404", "webhook", "serverless", "not"]) {
      assert.ok(qs.includes(topic), `no answers entry covers "${topic}"`);
    }
  });

  it("WP-3 CLASS: writeBack no longer claims delivery-side idempotency it does not have", () => {
    const wb = info.compute.writeBack;
    assert.ok(wb, "compute.writeBack must exist");
    // The lie: "through the delivery API or MCP — use idempotencyKey".
    assert.ok(
      !/delivery API or MCP/.test(wb),
      "writeBack again offers idempotencyKey/CAS for the delivery API, which supports neither",
    );
    assert.match(wb, /MCP-ONLY/, "the boundary must be stated, not merely un-stated");
    assert.match(wb, /Idempotency-Key/, "…naming the header a reader would otherwise go looking for");
  });

  it("WP-3 CLASS: and the same payload's boundary registry AGREES with it", () => {
    // The two halves of one payload contradicting each other is the defect
    // class. Assert they now say the same thing.
    const entry = info.briefing.notSupported.find((e) => /Idempotency-Key/i.test(e.capability));
    assert.ok(entry, "notSupported must still register the delivery idempotency boundary");
    assert.equal(entry.ref, "WP-1");
    assert.match(entry.alternative, /update_entry_if|idempotencyKey/, "the registry names the MCP alternative");
  });

  it("WP-6 (doc half): event-webhook signing is documented — header, algorithm, replay window", () => {
    const ws = info.compute.webhookSigning;
    assert.ok(ws, "compute.webhookSigning must exist — event webhooks are the most-used integration");
    assert.match(ws, /x-agentx-signature/, "the header NAME is the one thing a receiver cannot guess");
    assert.match(ws, /t=<unix-seconds>,v1=/, "the header shape");
    assert.match(ws, /HMAC_SHA256/, "the algorithm");
    assert.match(ws, /RAW/, "verify over raw bytes — parsing first silently breaks the hash");
    assert.match(ws, /300s|timing-safe/, "replay window + comparison discipline");
    // BOUNDARY-HONEST: the fail-open is real today (WP-6's code half closes it).
    // A doc that implied "always signed" would produce receivers that accept
    // forged posts, which is worse than the gap it papers over.
    assert.match(ws, /UNSIGNED/, "the no-secret fail-open must be stated out loud");
  });

  it("WP-6 BEHAVIORAL PIN: a project WITH a secret really signs, and one WITHOUT really does not", async () => {
    // The claim above is the only one in this file that would be dangerous if
    // wrong in either direction, so pin BOTH directions against the wire rather
    // than reading lib/webhook.ts. Ephemeral projects are minted with a signing
    // secret, so the unsigned case has to be constructed.
    const { sql } = await import("./helpers.mjs");
    const hits = [];
    const server = (await import("node:http")).createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ sig: req.headers["x-agentx-signature"] ?? null, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/hook`;
    try {
      const def = await mcp(p.mcpToken, "define_collection", {
        name: "signed_events",
        fields: [{ name: "title", label: "T", type: "text", required: true }],
        events: { created: [{ type: "webhook", url }] },
      });
      assert.ok(def.ok, def.errorText);

      // (a) WITH a secret — the fixture project has one.
      const c1 = await mcp(p.mcpToken, "create_entry", { collection: "signed_events", data: { title: "signed" } });
      assert.ok(c1.ok, c1.errorText);
      await waitFor(() => hits.length >= 1);
      const signed = hits.at(-1);
      assert.ok(signed.sig, "a project WITH a signing secret must sign — the doc says so");
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signed.sig);
      assert.ok(m, `header must match the documented shape, got: ${signed.sig}`);
      // Recompute the HMAC exactly as the doc instructs a receiver to.
      const { createHmac } = await import("node:crypto");
      const [{ webhook_signing_secret: secret }] =
        await sql`SELECT webhook_signing_secret FROM projects WHERE id = ${p.id}`;
      const expected = createHmac("sha256", secret).update(`${m[1]}.${signed.body}`).digest("hex");
      assert.equal(m[2], expected, "the documented recipe must reproduce the signature byte for byte");
      assert.ok(
        Math.abs(Date.now() / 1000 - Number(m[1])) < 300,
        "t must be inside the replay window the doc tells receivers to enforce",
      );

      // (b) WITHOUT a secret — the fail-open the doc warns about. This is the
      // negative control: if signing were unconditional, the warning would be
      // false and this assertion catches it.
      await sql`UPDATE projects SET webhook_signing_secret = NULL WHERE id = ${p.id}`;
      const before = hits.length;
      const c2 = await mcp(p.mcpToken, "create_entry", { collection: "signed_events", data: { title: "unsigned" } });
      assert.ok(c2.ok, c2.errorText);
      await waitFor(() => hits.length > before);
      assert.equal(
        hits.at(-1).sig,
        null,
        "with no signing secret the POST really is UNSIGNED — this is why the doc says to require the header",
      );
    } finally {
      server.close();
    }
  });

  it("D3: the browser-safe read-only token is discoverable at orientation, not only in a tool", () => {
    // D3 shipped so a static site could stop running a proxy whose only job was
    // holding a credential. An agent that never opens mint_delivery_token's
    // description would build that proxy anyway — the decision's whole value
    // depends on being found while planning.
    const ts = info.deliveryApi.tokenScopes;
    assert.match(ts, /readOnly:true/, "the flag must be named");
    assert.match(ts, /browser|BROWSER/, "…and what it is for");
    assert.match(ts, /proxy/, "…and the thing it replaces");
  });

  it("A2: the write-visibility convergence rule is in the ORIENTATION blob, not only in write responses", () => {
    const cv = info.deliveryApi.convergence;
    assert.ok(cv, "deliveryApi.convergence must exist");
    assert.match(cv, /15s/, "the timing half");
    assert.match(cv, /publicFilter/, "the visibility half — the one that is permanent, not transient");
    assert.match(cv, /describe_collection/, "…and the tool that settles it");
  });

  it("self-contained: the blob points at fetchable URLs, never a repo path", () => {
    const blob = JSON.stringify(info);
    for (const bad of ["docs/hooks.md", "in the AgentX repo", "lib/"]) {
      assert.ok(!blob.includes(bad), `a consumer cannot fetch "${bad}"`);
    }
    assert.match(info.urls.contract, /\/api\/contract$/);
    assert.match(info.urls.hooksDoc, /\/api\/docs\/hooks$/);
    // The signing doc must hand out the fetchable reference, since the
    // copy-paste verifier lives there.
    assert.match(info.compute.webhookSigning, /\/api\/docs\/hooks/);
  });
});

// 114c — ERROR COPY + CODES. Principle 4 says every refusal names the fix, and
// the codebase does that well in most places; this makes it universal and fixes
// the one place where the CODE actively misled.
describe("CONTRACT-1 — refusals name the fix, and the code says what it means", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("contract-errors");
  });
  after(() => p.destroy());

  it("BEHAVIORAL PIN: an oversized delivery body is E_VALIDATION (repairable), never E_INTERNAL", async () => {
    // The defect: 413 was missing from CODE_BY_STATUS, so it fell through to the
    // E_INTERNAL default — a code the registry defines as "not agent-repairable;
    // retry or report". A client following that advice retries the same
    // oversized payload forever. Verified on the wire, not by reading the map.
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "oversize",
      publicWrite: true,
      fields: [{ name: "body", label: "B", type: "richtext", publicRead: true }],
    });
    assert.ok(def.ok, def.errorText);
    const res = await fetch(`${BASE}/api/v1/oversize`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "x".repeat((1 << 20) + 4096) }),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.code, "E_VALIDATION", `413 must be repairable, got ${body.code}`);
    assert.notEqual(body.code, "E_INTERNAL", "the exact regression this pins out");
    // …and the message names the limit AND a remedy, so repair needs no round trip.
    assert.match(body.error, /1 MiB|1024 KiB/, "the cap must be named");
    assert.match(body.error, /bulk_create_entries|Split the payload/, "…and a way forward");

    // Positive control: a body under the cap still succeeds, so the 413 above
    // came from the size gate and not from something else being broken.
    const ok = await fetch(`${BASE}/api/v1/oversize`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.deliveryToken}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "y".repeat(32 * 1024) }),
    });
    assert.equal(ok.status, 201, `a 32 KiB body must pass (got ${ok.status})`);
  });

  it("every documented status→code mapping is a REAL registered code", async () => {
    // Guards the reverse of the bug above: a mapping to a code that isn't in the
    // registry would produce a code no client could look up.
    const res = await fetch(`${BASE}/api/mcp`);
    const { errorCodes } = await res.json();
    assert.ok(errorCodes?.E_VALIDATION, "GET /api/mcp must still serve the registry");
    for (const code of ["E_VALIDATION", "E_INTERNAL", "E_RATE_LIMITED", "E_AUTH", "E_NOT_FOUND"]) {
      assert.ok(code in errorCodes, `${code} must be registered`);
    }
  });

  it("thin refusals now name the discovery tool — the fix is in the message, not a round trip", async () => {
    const cases = [
      [{ tool: "delete_plugin", args: {} }, /list_plugins/],
      [{ tool: "enable_plugin", args: {} }, /list_plugins/],
      [{ tool: "delete_block", args: {} }, /list_blocks/],
      [{ tool: "define_plugin", args: {} }, /get_plugin/],
      [{ tool: "configure_inbound", args: { collection: "x" } }, /fieldMap|list_collections/],
    ];
    for (const [call, expected] of cases) {
      const r = await mcp(p.mcpToken, call.tool, call.args);
      assert.ok(!r.ok, `${call.tool} should refuse an empty call`);
      assert.match(
        r.errorText,
        expected,
        `${call.tool}'s refusal does not tell the agent where to look: ${r.errorText}`,
      );
    }
  });

  it("an unknown tool names tools/list, matching what the code registry promises", async () => {
    const r = await mcp(p.mcpToken, "make_me_a_sandwich", {});
    assert.ok(!r.ok);
    assert.match(r.errorText, /E_UNKNOWN_TOOL/);
    // ERROR_CODES documents "tools/list shows the full surface" — the MESSAGE
    // said only `unknown tool "x"`, so the advice lived somewhere the reader of
    // the error wasn't.
    assert.match(r.errorText, /tools\/list/, `the refusal must carry its own fix: ${r.errorText}`);
  });

  it("the contract is SELF-CONTAINED on error codes — /api/contract carries the registry", async () => {
    const md = await (await fetch(`${BASE}/api/contract`)).text();
    assert.match(md, /## Error codes/, "the contract must document its own error vocabulary");
    assert.match(md, /append-only/, "the stability guarantee clients depend on");
    const json = await (await fetch(`${BASE}/api/contract?format=json`)).json();
    assert.ok(json.errorCodes, "?format=json must carry the registry too");
    // SELF-CHECK: the rendered table and the served registry agree, and both
    // agree with the source of truth. One renderer, no second copy.
    const live = (await (await fetch(`${BASE}/api/mcp`)).json()).errorCodes;
    assert.deepEqual(
      Object.keys(json.errorCodes).sort(),
      Object.keys(live).sort(),
      "/api/contract and GET /api/mcp must serve the same code registry",
    );
    for (const code of Object.keys(live)) {
      assert.ok(md.includes(`\`${code}\``), `${code} is registered but missing from the contract table`);
    }
  });

  it("BEHAVIORAL PIN: a capacity breach really reports constraint `unique` with `limit` — as documented", async () => {
    // The errorFormat blob now tells agents to read `limit` to tell at-most-N
    // from exactly-one, because the constraint vocabulary is append-only and
    // capacity reuses `unique`. That is a claim about the wire.
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "capped_two",
      fields: [{ name: "slot", label: "S", type: "text", capacity: 1 }],
    });
    assert.ok(def.ok, def.errorText);
    await mcp(p.mcpToken, "create_entry", { collection: "capped_two", data: { slot: "x" } });
    const second = await mcp(p.mcpToken, "create_entry", { collection: "capped_two", data: { slot: "x" } });
    assert.ok(!second.ok);
    const issues = JSON.parse(/issues: (\[.*\])/s.exec(second.errorText)?.[1] ?? "[]");
    assert.ok(issues.length > 0, `expected a machine-readable issues block: ${second.errorText}`);
    assert.equal(issues[0].constraint, "unique", "documented: capacity reports as unique");
    assert.equal(issues[0].limit, 1, "…carrying limit, which is what distinguishes the two");
  });
});

/** Poll until cond() or ~10s — event delivery is async (retry cycle + backoff). */
async function waitFor(cond, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out waiting for the webhook delivery");
}

// 114d — CP2 of the Identity & Isolation sprint. Three items: one new gate and
// two pieces of copy that were true but unreachable.
//   MT-7  the Clerk claim requirement, moved from 403-time to define-time.
//   MT-4  dropping an `access` block joins the confirm gate (workflow precedent).
//   CONTRACT-2  the field-config vocabulary lives in the tool that needs it.
//
// The CONTRACT-2 test is DERIVED, which is the whole point: it reads
// COMMON_FIELD_CONFIG out of the source and demands define_collection name every
// knob. A behaviour-vs-description diff could never have caught that defect —
// nothing define_collection said was false, the essentials just lived in another
// tool — so the guard against it has to be structural.
describe("CONTRACT-1 CP2 — the schema contract tells the truth up front", () => {
  let p;
  let tools;

  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("sprint-cp2");
    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    tools = new Map((await res.json()).result.tools.map((t) => [t.name, t]));
  });
  after(() => p.destroy());

  it("CONTRACT-2 DERIVED: every knob in COMMON_FIELD_CONFIG is named by define_collection", () => {
    // Parse the knob names from the source of truth, then require the tool an
    // agent actually calls to mention each. Add an 11th knob and this fails
    // until both surfaces carry it.
    const src = readFileSync("lib/field-types.ts", "utf8");
    const block = /export const COMMON_FIELD_CONFIG = \[([\s\S]*?)\n\];/.exec(src);
    assert.ok(block, "could not read COMMON_FIELD_CONFIG");
    const knobs = [...block[1].matchAll(/^\s*["'`](\w+)\?:/gm)].map((m) => m[1]);
    assert.ok(knobs.length >= 6, `expected the common knobs, parsed: ${knobs.join(", ")}`);
    const desc = tools.get("define_collection").description;
    for (const k of knobs) {
      assert.ok(
        desc.includes(k),
        `COMMON_FIELD_CONFIG documents "${k}" but define_collection never names it — the exact seam two ` +
          `field reports walked into (capacity in the HAV1 run, computed dates on the wall)`,
      );
    }
  });

  it("CONTRACT-2: the computed vocabulary is present, not merely excluded", () => {
    // Before this, `computed` appeared in define_collection exactly once — inside
    // "not for unique/searchable/computed/..." — so an agent learned it was a
    // thing it could not localize, and nothing else.
    const desc = tools.get("define_collection").description;
    for (const fn of ["slugify", "template", "uuid"]) {
      assert.ok(desc.includes(fn), `computed fn "${fn}" is unreachable from define_collection`);
    }
    assert.match(desc, /fn:'now'/, "the reported case: stamping a date server-side");
  });

  it("CONTRACT-2: update_entry_if points at capacity as the other race-free model", () => {
    const desc = tools.get("update_entry_if").description;
    assert.match(desc, /capacity/, "the HAV1 agent chose this tool and never learned capacity existed");
    assert.match(desc, /counts LIVE/, "…and why capacity survives a cancellation without code");
  });

  it("MT-7 BEHAVIORAL: a claim rule's define response names the claim AND the Clerk setup", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "invoices",
      fields: [{ name: "amount", label: "A", type: "number", publicRead: true }],
      access: { read: { claim: "role", equals: "finance" } },
    });
    assert.ok(r.ok, r.errorText);
    const note = r.value.accessNote ?? "";
    assert.match(note, /IDENTITY SETUP REQUIRED/);
    assert.match(note, /"role"/, "the claim is NAMED — the fix should be one glance");
    assert.match(note, /Customize session token/, "the dashboard path, because that is where the fix lives");
    assert.match(note, /FLAT STRING/, "the nested-claim trap");
    // The load-bearing sentence: fail-closed means it LOOKS fine.
    assert.match(note, /SERVES NOBODY/);
  });

  it("MT-7 BEHAVIORAL: an org rule names the org claim and the active-organization requirement", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "org_docs",
      fields: [
        { name: "title", label: "T", type: "text", required: true, publicRead: true },
        { name: "org_id", label: "O", type: "text" },
      ],
      access: { read: "authenticated", ownerField: "org_id", org: { claim: "org_slug", field: "org_id" } },
    });
    assert.ok(r.ok, r.errorText);
    assert.match(r.value.accessNote, /"org_slug"/);
    assert.match(r.value.accessNote, /active organization/);
  });

  it("MT-7 CONTROL: a collection with NO claim rule gets no identity-setup note", async () => {
    // Without this the note could be unconditional noise and every assertion
    // above would still pass.
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "public_posts",
      fields: [{ name: "title", label: "T", type: "text", publicRead: true }],
      access: { read: "public" },
    });
    assert.ok(r.ok, r.errorText);
    assert.ok(
      !(r.value.accessNote ?? "").includes("IDENTITY SETUP REQUIRED"),
      "the note must fire only for claim/org rules — otherwise it is noise agents learn to skip",
    );
  });

  it("MT-4: dropping an access block is REFUSED without confirm, and the refusal says why it is invisible", async () => {
    const create = await mcp(p.mcpToken, "define_collection", {
      name: "gated_notes",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner_sub", label: "O", type: "text" },
      ],
      access: { read: "owner", write: "owner", ownerField: "owner_sub" },
    });
    assert.ok(create.ok, create.errorText);

    // A redefine that forgets `access` — the full-replace trap.
    const drop = await mcp(p.mcpToken, "define_collection", {
      name: "gated_notes",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner_sub", label: "O", type: "text" },
        { name: "pinned", label: "P", type: "boolean" },
      ],
    });
    assert.ok(drop.ok, drop.errorText);
    assert.equal(drop.value.requiresConfirmation, true, "an un-gating redefine must not apply silently");
    assert.equal(drop.value.code, "E_CONFIRM_REQUIRED");
    assert.match(drop.value.hint, /identity rules/);
    assert.match(drop.value.hint, /STOP being gated/, "the reason it needs a gate: nothing would look broken");
    assert.match(drop.value.hint, /re-send/, "…and the non-destructive way out");
    // NOTE the key: the confirm path returns the diff as `plan`, while the dryRun
    // path returns it as `diff`. Pre-existing asymmetry in the handler, asserted
    // here rather than smoothed over, so a future tidy-up has to notice this test.
    assert.deepEqual(drop.value.plan.accessRemoved, { read: true, write: true, org: false });

    // A refused plan applied nothing.
    const still = await mcp(p.mcpToken, "describe_collection", { name: "gated_notes" });
    assert.ok(still.value.access, "the refusal must not have partially applied");
    assert.equal(still.value.access.read, "owner");

    // confirm:true really un-gates it — the gate is a speed bump, not a wall.
    const forced = await mcp(p.mcpToken, "define_collection", {
      name: "gated_notes",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner_sub", label: "O", type: "text" },
        { name: "pinned", label: "P", type: "boolean" },
      ],
      confirm: true,
    });
    assert.ok(forced.ok, forced.errorText);
    const after = await mcp(p.mcpToken, "describe_collection", { name: "gated_notes" });
    assert.ok(!after.value.access, "confirm:true must actually remove the block");
  });

  it("MT-4 CONTROL: RE-SENDING the same access block is not destructive", async () => {
    // The negative control. If the gate fired on any redefine of a collection
    // that HAS access, the test above would pass while the feature was useless.
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "kept_notes",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner_sub", label: "O", type: "text" },
      ],
      access: { read: "owner", write: "owner", ownerField: "owner_sub" },
    });
    assert.ok(r.ok, r.errorText);
    const again = await mcp(p.mcpToken, "define_collection", {
      name: "kept_notes",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner_sub", label: "O", type: "text" },
        { name: "extra", label: "E", type: "text" },
      ],
      access: { read: "owner", write: "owner", ownerField: "owner_sub" },
    });
    assert.ok(again.ok, again.errorText);
    assert.notEqual(again.value.requiresConfirmation, true, "an additive change that KEEPS access must just apply");
  });

  it("MT-4: dryRun predicts the un-gating as would-require-confirm", async () => {
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "kept_notes",
      fields: [
        { name: "body", label: "B", type: "text", required: true, publicRead: true },
        { name: "owner_sub", label: "O", type: "text" },
      ],
      dryRun: true,
    });
    assert.ok(r.ok, r.errorText);
    assert.equal(r.value.dryRun, true);
    assert.equal(r.value.wouldRequireConfirmation, true, "the dry plan must predict the confirm gate");
    assert.ok(r.value.diff.accessRemoved, "…and show WHAT makes it destructive");
  });
});
