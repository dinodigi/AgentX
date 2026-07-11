/**
 * Repair the four missing `project_id → projects` FK cascades (see the
 * missing-fk-cascades memory). db:push-vs-Neon-PG18 drift left these tables
 * without the FK the schema declares, so DELETE FROM projects orphaned them.
 * Adds the constraints (ON DELETE CASCADE) after clearing any existing orphans.
 * Idempotent — skips a constraint that already exists. Additive + safe.
 *
 * Run:  npx tsx scripts/migrate-fk-cascades.ts
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const TABLES = ["project_members", "entries_trash", "entry_versions", "transact_receipts"] as const;

async function main() {
  const existing = new Set(
    ((await sql`select conname from pg_constraint where contype='f' and confrelid='projects'::regclass`) as any[]).map(
      (r) => r.conname as string,
    ),
  );

  const addFk: Record<string, () => Promise<unknown>> = {
    project_members: () =>
      sql`alter table project_members add constraint project_members_project_id_projects_id_fk foreign key (project_id) references projects(id) on delete cascade`,
    entries_trash: () =>
      sql`alter table entries_trash add constraint entries_trash_project_id_projects_id_fk foreign key (project_id) references projects(id) on delete cascade`,
    entry_versions: () =>
      sql`alter table entry_versions add constraint entry_versions_project_id_projects_id_fk foreign key (project_id) references projects(id) on delete cascade`,
    transact_receipts: () =>
      sql`alter table transact_receipts add constraint transact_receipts_project_id_projects_id_fk foreign key (project_id) references projects(id) on delete cascade`,
  };
  const clearOrphans: Record<string, () => Promise<unknown[]>> = {
    project_members: () => sql`delete from project_members where project_id not in (select id from projects) returning id` as Promise<unknown[]>,
    entries_trash: () => sql`delete from entries_trash where project_id not in (select id from projects) returning id` as Promise<unknown[]>,
    entry_versions: () => sql`delete from entry_versions where project_id not in (select id from projects) returning id` as Promise<unknown[]>,
    transact_receipts: () => sql`delete from transact_receipts where project_id not in (select id from projects) returning id` as Promise<unknown[]>,
  };

  for (const t of TABLES) {
    const name = `${t}_project_id_projects_id_fk`;
    if (existing.has(name)) {
      console.log(`  ${t}: FK already present — skip`);
      continue;
    }
    const orphans = await clearOrphans[t]();
    await addFk[t]();
    console.log(`  ${t}: removed ${orphans.length} orphan(s), added ON DELETE CASCADE FK`);
  }

  console.log("\nRe-audit — every FK referencing projects:");
  const rows = (await sql`
    select con.conrelid::regclass::text as child, con.confdeltype as del
    from pg_constraint con where con.contype='f' and con.confrelid='projects'::regclass
    order by child`) as any[];
  for (const r of rows) console.log(`  ${r.del === "c" ? "✓" : "✗"} ${r.child.padEnd(22)} ${r.del === "c" ? "CASCADE" : r.del}`);
  console.log(`\n${rows.length} FKs total (expect 14, all CASCADE).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
