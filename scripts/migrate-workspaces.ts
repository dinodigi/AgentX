/**
 * B1 migration — workspaces + workspace_members + projects.workspace_id.
 *
 * db:push is broken against Neon PG18 for incremental changes, so this applies
 * the DDL by hand (all IF NOT EXISTS — safe to re-run) and backfills every
 * existing project into a workspace:
 *   - a personal workspace per distinct OPERATOR project-member (they become its
 *     owner), assigned their operator projects;
 *   - orphan projects (no operator member) → a shared "Legacy Workspace".
 * Client project_members rows are left untouched — they remain the per-project
 * share (the outsider rung). Additive + idempotent.
 *
 * Run:  npx tsx scripts/migrate-workspaces.ts
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

function workspaceName(email: string): string {
  const local = (email.split("@")[0] || "user").replace(/[._-]+/g, " ").trim();
  const titled = local.charAt(0).toUpperCase() + local.slice(1);
  return `${titled}'s Workspace`;
}

async function main() {
  console.log("Applying DDL …");
  await sql`CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS workspace_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    clerk_user_id text NOT NULL,
    email text NOT NULL,
    role text NOT NULL DEFAULT 'manager',
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_user_idx
    ON workspace_members (workspace_id, clerk_user_id)`;
  await sql`ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE`;

  console.log("Backfilling projects into workspaces …");
  const projects = (await sql`SELECT id, workspace_id FROM projects`) as { id: string; workspace_id: string | null }[];
  const members = (await sql`SELECT project_id, clerk_user_id, email, role FROM project_members`) as {
    project_id: string;
    clerk_user_id: string;
    email: string;
    role: string;
  }[];

  const personalWs = new Map<string, string>(); // clerkUserId -> workspaceId
  let legacyWsId: string | null = null;
  let assigned = 0;

  const ownerWorkspace = async (userId: string, email: string): Promise<string> => {
    const cached = personalWs.get(userId);
    if (cached) return cached;
    // Idempotency: reuse a workspace this user already owns.
    const existing = (await sql`
      SELECT w.id FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.clerk_user_id = ${userId} AND m.role = 'owner' LIMIT 1`) as { id: string }[];
    let wsId = existing[0]?.id;
    if (!wsId) {
      const [row] = (await sql`INSERT INTO workspaces (name) VALUES (${workspaceName(email)}) RETURNING id`) as { id: string }[];
      wsId = row.id;
      await sql`INSERT INTO workspace_members (workspace_id, clerk_user_id, email, role)
        VALUES (${wsId}, ${userId}, ${email}, 'owner')
        ON CONFLICT (workspace_id, clerk_user_id) DO NOTHING`;
    }
    personalWs.set(userId, wsId);
    return wsId;
  };

  for (const p of projects) {
    if (p.workspace_id) continue;
    const operators = members.filter((m) => m.project_id === p.id && m.role === "operator");
    let wsId: string;
    if (operators.length > 0) {
      wsId = await ownerWorkspace(operators[0].clerk_user_id, operators[0].email);
    } else {
      if (!legacyWsId) {
        const [row] = (await sql`INSERT INTO workspaces (name) VALUES ('Legacy Workspace') RETURNING id`) as { id: string }[];
        legacyWsId = row.id;
      }
      wsId = legacyWsId;
    }
    await sql`UPDATE projects SET workspace_id = ${wsId} WHERE id = ${p.id}`;
    assigned++;
  }

  const [{ n: wsCount }] = (await sql`SELECT count(*)::int AS n FROM workspaces`) as { n: number }[];
  const [{ n: orphans }] = (await sql`SELECT count(*)::int AS n FROM projects WHERE workspace_id IS NULL`) as { n: number }[];
  console.log(`\n✅ Migration complete`);
  console.log(`   workspaces:        ${wsCount}`);
  console.log(`   projects assigned: ${assigned}`);
  console.log(`   projects still without a workspace: ${orphans}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
