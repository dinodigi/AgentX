/**
 * Seed the Countryside CRM plugin into the DB-backed catalog as a GLOBAL def
 * (operator-authored, first-party). Idempotent upsert. Run:
 *   node --env-file=.env scripts/seed-countryside-plugin.mjs
 * The def's validity is proven by scripts/smoke/78-plugin-catalog-db.test.mjs,
 * which applies the full baseline (workflow + computed-unique) end to end.
 */
import { neon } from "@neondatabase/serverless";
import { COUNTRYSIDE_PLUGIN } from "./countryside-plugin-def.mjs";

const sql = neon(process.env.DATABASE_URL);
await sql`
  INSERT INTO plugin_defs (id, project_id, definition, updated_at)
  VALUES (${COUNTRYSIDE_PLUGIN.id}, NULL, ${JSON.stringify(COUNTRYSIDE_PLUGIN)}::jsonb, now())
  ON CONFLICT (id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()`;
console.log(`seeded GLOBAL plugin "${COUNTRYSIDE_PLUGIN.id}" v${COUNTRYSIDE_PLUGIN.version}`);
