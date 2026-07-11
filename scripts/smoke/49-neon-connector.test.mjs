import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { BASE, ensureServer, createEphemeralProject, connectNeon, mcp, delivery } from "./helpers.mjs";

/**
 * A2 acceptance: a project with a `neon` connector keeps ALL content in its
 * own database — a REAL second database on the same Neon instance — while
 * config stays control-plane. The connector row is seeded without installing
 * the schema, so the very first content op exercises the migrate-before-
 * first-use gate (which must install v1 transparently).
 */

function directUrl(raw) {
  const u = new URL(raw);
  u.hostname = u.hostname.replace(/-pooler(?=\.)/, "");
  return u;
}

const adminUrl = directUrl(process.env.DATABASE_URL).toString();
const admin = neon(adminUrl); // control-plane + CREATE/DROP DATABASE
const dbName = `smoke_tenant_${Date.now()}`;

let project;
let tenantSql; // direct SQL into the scratch tenant DB

before(async () => {
  await ensureServer();
  project = await createEphemeralProject("neon-connector");
  await admin(`CREATE DATABASE ${dbName}`);
  const scratch = directUrl(process.env.DATABASE_URL);
  scratch.pathname = `/${dbName}`;
  tenantSql = neon(scratch.toString());
  await connectNeon(project.id, scratch.toString());
});

after(async () => {
  await project.destroy();
  await admin(`DROP DATABASE ${dbName} WITH (FORCE)`);
});

test("first content op passes the migrate gate; writes land in the tenant DB only", async () => {
  const defined = await mcp(project.mcpToken, "define_collection", {
    name: "posts",
    fields: [
      { name: "title", label: "Title", type: "text", required: true, publicRead: true, unique: true },
      { name: "body", label: "Body", type: "text", publicRead: true },
    ],
  });
  assert.equal(defined.ok, true, defined.errorText);

  // The gate ran during define (its data scans resolve the tenant DB): the
  // scratch DB must now carry the versioned schema.
  const [ver] = await tenantSql`SELECT max(version) AS v FROM _schema_migrations`;
  assert.equal(Number(ver.v), 1, "migrate-on-first-use should have installed v1");

  const created = await mcp(project.mcpToken, "create_entry", {
    collection: "posts",
    data: { title: "hello tenant", body: "isolated" },
  });
  assert.equal(created.ok, true, created.errorText);
  const id = created.value.id;

  // Tenant DB has the row…
  const inTenant = await tenantSql`SELECT data->>'title' AS title FROM entries WHERE id = ${id}`;
  assert.equal(inTenant.length, 1);
  assert.equal(inTenant[0].title, "hello tenant");

  // …the control DB does NOT (for this project), while its CONFIG does live
  // control-side (collections is control-plane by design).
  const inControl = await admin(`SELECT id FROM entries WHERE project_id = '${project.id}'`);
  assert.equal(inControl.length, 0, "control DB must hold no content for a connector-backed project");
  const cols = await admin(`SELECT name FROM collections WHERE project_id = '${project.id}'`);
  assert.equal(cols.length, 1);
  assert.equal(cols[0].name, "posts");
});

test("reads route to the tenant DB: MCP query + delivery GET serve the row", async () => {
  const q = await mcp(project.mcpToken, "query_entries", { collection: "posts" });
  assert.equal(q.ok, true, q.errorText);
  assert.equal(q.value.entries.length, 1);
  assert.equal(q.value.entries[0].data.title, "hello tenant");

  const got = await delivery(project.deliveryToken, "/posts");
  assert.equal(got.status, 200);
  assert.equal(got.json.data.length, 1);
  assert.equal(got.json.data[0].title, "hello tenant");
});

test("the tenant-side partial unique index enforces (index sync ran there)", async () => {
  const dup = await mcp(project.mcpToken, "create_entry", {
    collection: "posts",
    data: { title: "hello tenant" },
  });
  assert.equal(dup.ok, false);
  assert.match(dup.errorText, /unique/i);
});

test("derived writes land tenant-side: versions, change feed, audit, trash", async () => {
  const q = await mcp(project.mcpToken, "query_entries", { collection: "posts" });
  const id = q.value.entries[0].id;

  const updated = await mcp(project.mcpToken, "update_entry", {
    collection: "posts",
    id,
    data: { body: "edited" },
  });
  assert.equal(updated.ok, true, updated.errorText);

  // recordVersion is deferred — poll briefly for it.
  let versions = [];
  for (let i = 0; i < 20 && versions.length === 0; i++) {
    versions = await tenantSql`SELECT id FROM entry_versions WHERE entry_id = ${id}`;
    if (versions.length === 0) await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(versions.length >= 1, true, "version snapshot should be in the tenant DB");

  const changes = await tenantSql`SELECT kind FROM entry_changes WHERE project_id = ${project.id} ORDER BY seq`;
  assert.equal(changes.length >= 2, true, "created+updated change rows in the tenant DB");

  let audit = [];
  for (let i = 0; i < 20 && audit.length === 0; i++) {
    audit = await tenantSql`SELECT action FROM audit_log WHERE project_id = ${project.id}`;
    if (audit.length === 0) await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(audit.length >= 1, true, "audit rows in the tenant DB");

  const zeroDerived = await admin(
    `SELECT (SELECT count(*) FROM entry_versions WHERE project_id = '${project.id}')::int
          + (SELECT count(*) FROM entry_changes WHERE project_id = '${project.id}')::int
          + (SELECT count(*) FROM audit_log     WHERE project_id = '${project.id}')::int AS n`,
  );
  assert.equal(Number(zeroDerived[0].n), 0, "no derived rows for this project in the control DB");

  // Trash: delete moves the row tenant-side; restore brings it back.
  const del = await mcp(project.mcpToken, "delete_entry", { collection: "posts", id });
  assert.equal(del.ok, true, del.errorText);
  const trashed = await tenantSql`SELECT id FROM entries_trash WHERE id = ${id}`;
  assert.equal(trashed.length, 1, "trashed row lives in the tenant DB");

  const restored = await mcp(project.mcpToken, "restore_entry", { collection: "posts", id });
  assert.equal(restored.ok, true, restored.errorText);
  const back = await tenantSql`SELECT id FROM entries WHERE id = ${id}`;
  assert.equal(back.length, 1);
});

test("a sibling fallback project still writes to the control DB (no cross-talk)", async () => {
  const sibling = await createEphemeralProject("neon-sibling");
  try {
    const defined = await mcp(sibling.mcpToken, "define_collection", {
      name: "notes",
      fields: [{ name: "note", label: "Note", type: "text", required: true }],
    });
    assert.equal(defined.ok, true, defined.errorText);
    const created = await mcp(sibling.mcpToken, "create_entry", {
      collection: "notes",
      data: { note: "shared plane" },
    });
    assert.equal(created.ok, true, created.errorText);

    const inControl = await admin(`SELECT id FROM entries WHERE project_id = '${sibling.id}'`);
    assert.equal(inControl.length, 1, "fallback project's content stays control-side");
    const inTenant = await tenantSql`SELECT id FROM entries WHERE project_id = ${sibling.id}`;
    assert.equal(inTenant.length, 0, "and never leaks into another tenant's DB");
  } finally {
    await sibling.destroy();
  }
});
