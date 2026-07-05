import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

/**
 * The strongest test in the suite: the generated client must (1) typecheck
 * under --strict next to a typed consumer, and (2) actually work at runtime
 * against the live delivery API. If either breaks, get_client_code is lying.
 */
describe("get_client_code: generated client compiles and runs", () => {
  let p;
  let tmp;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("client-code");
    tmp = mkdtempSync(path.join(tmpdir(), "agentx-client-"));

    await mcp(p.mcpToken, "define_collection", {
      name: "posts",
      fields: [
        { name: "title", label: "Title", type: "text", required: true, publicRead: true },
        { name: "price", label: "Price", type: "number", publicRead: true },
        { name: "status", label: "Status", type: "enum", options: ["draft", "live"], publicRead: true },
        { name: "internal", label: "Internal", type: "text" },
      ],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "messages",
      publicWrite: true,
      fields: [
        { name: "email", label: "Email", type: "text", required: true },
        { name: "body", label: "Body", type: "text" },
        { name: "attachment", label: "Attachment", type: "asset" },
      ],
    });
    await mcp(p.mcpToken, "define_collection", {
      name: "secrets",
      fields: [{ name: "note", label: "Note", type: "text" }],
    });
    await mcp(p.mcpToken, "bulk_create_entries", {
      collection: "posts",
      entries: [
        { title: "Alpha", price: 50, status: "live", internal: "x" },
        { title: "Beta", price: 150, status: "draft" },
      ],
    });
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
    return p.destroy();
  });

  let client; // compiled module, shared by the runtime tests below

  it("generates, typechecks under --strict, and compiles", async () => {
    const r = await mcp(p.mcpToken, "get_client_code", {});
    assert.ok(r.ok, r.errorText);
    assert.deepEqual(r.value.collections.sort(), ["messages", "posts"]);
    assert.deepEqual(r.value.skipped, ["secrets"]);
    assert.equal(r.value.filename, "agentx.ts");
    assert.match(r.value.code, /export interface Posts \{/);
    assert.match(r.value.code, /"draft" \| "live"/);
    const postsBlock = r.value.code.match(/export interface Posts \{[^}]*\}/)?.[0] ?? "";
    assert.ok(postsBlock.includes("title"), "Posts read type missing");
    assert.ok(!postsBlock.includes("internal"), "private field leaked into the public read type");

    writeFileSync(path.join(tmp, "agentx.ts"), r.value.code);
    // A consumer that exercises the generated types: wrong shapes here = tsc failure.
    writeFileSync(
      path.join(tmp, "consumer.ts"),
      `import { createClient, AgentXError, type Posts, type MessagesCreate } from "./agentx";
const ax = createClient({ token: "t" });
ax.setUserToken(null);
export async function main(): Promise<void> {
  const rows: Posts[] = await ax.posts.list({
    filter: { status: "live", price: 50 },
    sort: { field: "price", dir: "asc" },
    limit: 5,
  });
  const one: Posts = await ax.posts.get(rows[0].id);
  const msg: MessagesCreate = { email: "a@b.c", body: "hi" };
  const created: { id: string } = await ax.messages.create(msg);
  const up: { id: string; url: string } = await ax.messages.upload(new Blob(["x"]), "x.txt");
  if (!(one.title.length > 0 && created.id && up.id)) throw new AgentXError(500, "unreachable");
}
`,
    );

    const tscBin = path.resolve("node_modules", "typescript", "bin", "tsc");
    execFileSync(
      process.execPath,
      [tscBin, "--strict", "--target", "es2022", "--module", "commonjs",
       "--lib", "es2022,dom", "--outDir", "out", "agentx.ts", "consumer.ts"],
      { cwd: tmp, stdio: "pipe" },
    );

    const require = createRequire(import.meta.url);
    client = require(path.join(tmp, "out", "agentx.js"));
    assert.equal(typeof client.createClient, "function");
  });

  it("compiled client reads the delivery API (public projection intact)", async () => {
    const ax = client.createClient({ baseUrl: `${BASE}/api/v1`, token: p.deliveryToken });
    const rows = await ax.posts.list({ sort: { field: "price", dir: "asc" } });
    assert.deepEqual(rows.map((r) => r.title), ["Alpha", "Beta"]);
    assert.ok(!("internal" in rows[0]), "private field leaked at runtime");

    const live = await ax.posts.list({ filter: { status: "live" } });
    assert.equal(live.length, 1);

    const one = await ax.posts.get(rows[0].id);
    assert.equal(one.title, "Alpha");
  });

  it("compiled client writes through publicWrite and surfaces AgentXError", async () => {
    const ax = client.createClient({ baseUrl: `${BASE}/api/v1`, token: p.deliveryToken });
    const created = await ax.messages.create({ email: "a@b.c", body: "hello" });
    assert.ok(created.id);
    const check = await mcp(p.mcpToken, "get_entry", { collection: "messages", id: created.id });
    assert.equal(check.value.data.email, "a@b.c");

    const up = await ax.messages.upload(new Blob(["ping"], { type: "text/plain" }), "ping.txt");
    assert.ok(up.id && up.url, "generated upload() must return {id, url}");

    // Filtering on a private field is a type error in TS; forced via JS it must
    // throw AgentXError carrying the server's 422 + hint and machine code.
    await assert.rejects(
      () => ax.posts.list({ filter: { internal: "x" } }),
      (e) =>
        e.name === "AgentXError" &&
        e.status === 422 &&
        e.code === "E_VALIDATION" &&
        /non-public/.test(e.message),
    );
  });
});
