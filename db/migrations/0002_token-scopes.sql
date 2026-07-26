-- MT-1 / D2: the capability subset an mcp token may exercise.
-- NULL = full access (grandfathered), which is every pre-existing token — so
-- adding this column changes no behavior until something writes a value.
-- IF NOT EXISTS keeps it a safe no-op on databases already patched by hand.
ALTER TABLE "project_tokens" ADD COLUMN IF NOT EXISTS "scopes" jsonb;
