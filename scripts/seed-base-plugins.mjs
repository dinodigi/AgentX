/**
 * Seed the wave-1 BASE plugins into the DB-backed catalog as GLOBAL defs
 * (operator-authored, first-party). Idempotent upsert. Run:
 *   node --env-file=.env scripts/seed-base-plugins.mjs
 * Validity is proven by scripts/smoke/90-wave1-bases.test.mjs.
 */
import { neon } from "@neondatabase/serverless";
import { BOOKING_PLUGIN } from "../plugins/booking.mjs";
import { WAITLIST_PLUGIN } from "../plugins/waitlist.mjs";
import { FEEDBACK_WALL_PLUGIN } from "../plugins/feedback-wall.mjs";
import { MEDIA_GALLERY_PLUGIN } from "../plugins/media-gallery.mjs";

const sql = neon(process.env.DATABASE_URL);
for (const def of [BOOKING_PLUGIN, WAITLIST_PLUGIN, FEEDBACK_WALL_PLUGIN, MEDIA_GALLERY_PLUGIN]) {
  await sql`
    INSERT INTO plugin_defs (id, project_id, definition, updated_at)
    VALUES (${def.id}, NULL, ${JSON.stringify(def)}::jsonb, now())
    ON CONFLICT (id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()`;
  console.log(`seeded GLOBAL base "${def.id}" v${def.version} (provides: ${def.provides})`);
}
