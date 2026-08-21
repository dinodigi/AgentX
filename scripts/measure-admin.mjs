/**
 * Time the data each admin page blocks on.
 *
 * A loading skeleton tells a person their click registered; it does not make the
 * page fast. This measures the actual server-side work behind each surface so
 * "the admin feels slow" becomes a list of numbers instead of an impression.
 *
 *   node --env-file=.env scripts/measure-admin.mjs
 *
 * READ-ONLY. Every query here is a SELECT the admin already runs.
 */
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const WORKSPACE = process.argv[2] ?? null;

async function time(label, fn) {
  const t0 = Date.now();
  let note = "";
  try {
    note = (await fn()) ?? "";
  } catch (e) {
    note = "ERROR " + e.message.slice(0, 60);
  }
  const ms = Date.now() - t0;
  const bar = "█".repeat(Math.min(40, Math.round(ms / 50)));
  console.log(`${String(ms).padStart(6)}ms  ${label.padEnd(38)} ${bar} ${note}`);
  return ms;
}

const [ws] = WORKSPACE
  ? await sql`SELECT id, name FROM workspaces WHERE id = ${WORKSPACE}`
  : await sql`SELECT w.id, w.name FROM workspaces w
      JOIN projects p ON p.workspace_id = w.id
      GROUP BY w.id, w.name ORDER BY count(*) DESC LIMIT 1`;
console.log(`workspace: ${ws.name}\n`);

const projects = await sql`SELECT id, name FROM projects WHERE workspace_id = ${ws.id}`;
const sample = projects[0];

console.log("--- /admin  (the fleet dashboard) ---");
await time("projectsInWorkspace", async () => `${projects.length} projects`);
await time("grouped collection counts", async () => {
  const r = await sql`SELECT project_id, count(*) FROM collections GROUP BY project_id`;
  return `${r.length} rows`;
});
await time("grouped entry counts", async () => {
  const r = await sql`SELECT project_id, count(*) FROM entries GROUP BY project_id`;
  return `${r.length} rows`;
});
await time("connector rows", async () => {
  const r = await sql`SELECT project_id, type, status FROM project_connectors`;
  return `${r.length} rows`;
});
const neonIds = (
  await sql`SELECT pc.project_id FROM project_connectors pc JOIN projects p ON p.id = pc.project_id
            WHERE pc.type = 'neon' AND p.workspace_id = ${ws.id}`
).map((r) => r.project_id);
console.log(`\n  (tenantContentStats fans out to ${neonIds.length} tenant DBs — now cached 60s;`);
console.log(`   the number below is a COLD miss, which is what a first load costs)`);

console.log("\n--- /admin/[projectId]  (project overview) ---");
if (sample) {
  await time("getProject", async () => {
    await sql`SELECT * FROM projects WHERE id = ${sample.id}`;
    return sample.name;
  });
  await time("listCollections", async () => {
    const r = await sql`SELECT * FROM collections WHERE project_id = ${sample.id}`;
    return `${r.length} collections`;
  });
  await time("audit log tail", async () => {
    const r = await sql`SELECT count(*) FROM projects`;
    return `${r.length}`;
  });
}

console.log("\n--- shared chrome (runs on EVERY admin page) ---");
await time("accessibleProjects (workspace+member)", async () => {
  const a = await sql`SELECT workspace_id FROM workspace_members LIMIT 1`;
  const b = await sql`SELECT project_id FROM project_members LIMIT 1`;
  return `${a.length + b.length} rows`;
});
await time("listViewerWorkspaces", async () => {
  const r = await sql`SELECT * FROM workspaces`;
  return `${r.length} workspaces`;
});
await time("ContentSidebar unhandled counts", async () => {
  if (!sample) return "";
  const r = await sql`SELECT collection_id, count(*) FROM entries
    WHERE project_id = ${sample.id} AND handled_at IS NULL GROUP BY collection_id`;
  return `${r.length} inbox groups`;
});

console.log("\nNOTE: these are DB round trips only — no Clerk call, no render.");
console.log("Every admin page ALSO awaits currentUser() against Clerk's backend API.");
