import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp, delivery } from "./helpers.mjs";

/**
 * B2 lifecycle: setup-state projects are dark on the agent + delivery
 * surfaces until activated, and the free sandbox's hard caps hold (the abuse
 * gate behind self-serve creation). Legacy projects (plan NULL) stay ungated
 * — every other suite in this directory is the regression proof for that.
 */

const sql = neon(process.env.DATABASE_URL);

function mintToken() {
  const raw = "agx_" + randomBytes(24).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

/** A project row in an explicit lifecycle state, with fresh tokens. */
async function makeProject(label, { status, plan }) {
  const [project] = await sql`
    INSERT INTO projects (name, branding, webhook_signing_secret, status, plan)
    VALUES (${`smoke ${label} ${Date.now()}`}, '{"displayName":"lifecycle","primaryColor":"#0f766e"}'::jsonb,
            ${randomBytes(32).toString("hex")}, ${status}, ${plan})
    RETURNING id`;
  const mcpTok = mintToken();
  const delTok = mintToken();
  await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label) VALUES
    (${project.id}, ${mcpTok.hash}, 'mcp', 'smoke'),
    (${project.id}, ${delTok.hash}, 'delivery', 'smoke')`;
  return {
    id: project.id,
    mcpToken: mcpTok.raw,
    deliveryToken: delTok.raw,
    destroy: async () => {
      await sql`DELETE FROM projects WHERE id = ${project.id}`;
    },
  };
}

test("a setup-state project is dark on MCP and delivery", async () => {
  await ensureServer();
  const p = await makeProject("setup-dark", { status: "setup", plan: "byo" });
  try {
    const r = await mcp(p.mcpToken, "list_collections", {});
    assert.equal(r.ok, false);
    assert.match(r.errorText, /E_PROJECT_SETUP|hasn't finished setup/);

    const d = await delivery(p.deliveryToken, "/anything");
    assert.equal(d.status, 401, "a setup project has no public surface");
  } finally {
    await p.destroy();
  }
});

test("activation lights the surfaces up", async () => {
  const p = await makeProject("activates", { status: "setup", plan: "byo" });
  try {
    await sql`UPDATE projects SET status = 'active' WHERE id = ${p.id}`;
    // The in-app activate action revalidates the token cache tag; a direct SQL
    // flip can't, so prove the semantics with a FRESH token (cache miss reads
    // the new status).
    const fresh = mintToken();
    await sql`INSERT INTO project_tokens (project_id, token_hash, scope, label)
      VALUES (${p.id}, ${fresh.hash}, 'mcp', 'smoke-fresh')`;
    const r = await mcp(fresh.raw, "list_collections", {});
    assert.equal(r.ok, true, r.errorText);
  } finally {
    await p.destroy();
  }
});

test("sandbox caps: entries", async () => {
  const p = await makeProject("sandbox-entries", { status: "active", plan: "sandbox" });
  try {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "note", label: "Note", type: "text" }],
    });
    assert.equal(def.ok, true, def.errorText);
    const [col] = await sql`SELECT id FROM collections WHERE project_id = ${p.id} AND name = 'notes'`;
    await sql`INSERT INTO entries (project_id, collection_id, data)
      SELECT ${p.id}, ${col.id}, '{}'::jsonb FROM generate_series(1, 1000)`;

    const over = await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { note: "one too many" } });
    assert.equal(over.ok, false);
    assert.match(over.errorText, /E_CAP_REACHED/);
    assert.match(over.errorText, /entries/);
  } finally {
    await p.destroy();
  }
});

test("sandbox caps: media bytes", async () => {
  const p = await makeProject("sandbox-media", { status: "active", plan: "sandbox" });
  try {
    await sql`INSERT INTO assets (project_id, r2_key, filename, content_type, size, url)
      VALUES (${p.id}, ${`${p.id}/seed/big.bin`}, 'big.bin', 'application/pdf', '104857600', 'https://x.test/big.bin')`;
    const up = await mcp(p.mcpToken, "upload_asset", {
      filename: "small.txt",
      contentType: "text/plain",
      dataBase64: Buffer.from("tiny").toString("base64"),
    });
    assert.equal(up.ok, false);
    assert.match(up.errorText, /E_CAP_REACHED/);
    assert.match(up.errorText, /media storage/);
  } finally {
    await p.destroy();
  }
});

test("sandbox caps: collections", async () => {
  const p = await makeProject("sandbox-cols", { status: "active", plan: "sandbox" });
  try {
    for (let i = 0; i < 20; i++) {
      await sql`INSERT INTO collections (project_id, name, display_name, fields)
        VALUES (${p.id}, ${`col_${i}`}, ${`Col ${i}`}, '[]'::jsonb)`;
    }
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "one_more",
      fields: [{ name: "x", label: "X", type: "text" }],
    });
    assert.equal(def.ok, false);
    assert.match(def.errorText, /E_CAP_REACHED/);
    assert.match(def.errorText, /collections/);
  } finally {
    await p.destroy();
  }
});

test("legacy (plan NULL) projects stay ungated", async () => {
  const p = await createEphemeralProject("lifecycle-legacy");
  try {
    const def = await mcp(p.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "note", label: "Note", type: "text" }],
    });
    assert.equal(def.ok, true, def.errorText);
    const c = await mcp(p.mcpToken, "create_entry", { collection: "notes", data: { note: "free as before" } });
    assert.equal(c.ok, true, c.errorText);
  } finally {
    await p.destroy();
  }
});
