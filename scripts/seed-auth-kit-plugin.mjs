/**
 * Seed the Auth Kit plugin into the DB-backed catalog as a GLOBAL def
 * (operator-authored, first-party). Idempotent upsert. Run:
 *   node --env-file=.env scripts/seed-auth-kit-plugin.mjs
 * The def's validity is proven by scripts/smoke/82-auth-kit-plugin.test.mjs,
 * which applies the full baseline (workflows + computed uuid/template uniques)
 * and exercises the acceptance criteria.
 */
import { neon } from "@neondatabase/serverless";
import { AUTH_KIT_PLUGIN } from "../plugins/auth-kit.mjs";

const sql = neon(process.env.DATABASE_URL);
await sql`
  INSERT INTO plugin_defs (id, project_id, definition, updated_at)
  VALUES (${AUTH_KIT_PLUGIN.id}, NULL, ${JSON.stringify(AUTH_KIT_PLUGIN)}::jsonb, now())
  ON CONFLICT (id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()`;
console.log(`seeded GLOBAL plugin "${AUTH_KIT_PLUGIN.id}" v${AUTH_KIT_PLUGIN.version}`);
