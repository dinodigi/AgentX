-- D1 columns, declared in db/schema.ts on 2026-07-25 to close ORM drift.
--
-- Both columns were ALREADY hand-applied to the prod and test control DBs on
-- 2026-07-23 (scripts/migrate-token-expiry-batch.ts) because `db:push` is
-- broken against Neon PG18. This file exists so a FRESH bootstrap from the
-- migrations folder — which is how the test DB was built — produces a schema
-- that matches production instead of silently omitting them.
--
-- IF NOT EXISTS is deliberate: this must be a safe no-op on any database that
-- already took the hand-applied path.
ALTER TABLE "project_plugins" ADD COLUMN IF NOT EXISTS "realized_names" jsonb;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
