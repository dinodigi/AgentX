# Runbook — Backup & restore

## What a full backup consists of

1. **Schema + settings** — `export_project` (MCP) or Settings → Manifest →
   Download. One JSON doc: branding, collections, fields, rules, events.
2. **Data** — `export_entries` per collection (MCP) or the CSV/JSON buttons on
   each collection page. Raw values; relations/assets stay ids. 5,000-row cap
   per export (truncated flag set beyond — page with repeated exports if a
   collection ever exceeds it).
3. **Assets** — bytes live in R2 (bucket `agentx`, keys namespaced by project
   id). R2 has no automatic versioning here; for a hard copy, sync the
   project's key prefix with rclone/aws-cli.
4. **Postgres safety net** — Neon point-in-time restore covers the whole
   database (all projects at once) independent of the above.

## Restore paths

- **Whole-database disaster** → Neon PITR to a branch, verify, promote. This
  is the fastest and most faithful path; prefer it when available.
- **Single project, from exports** →
  1. Create a fresh project (admin → New project).
  2. `import_project` with the manifest (idempotent; destructive diffs ask
     for confirm).
  3. Re-create entries per collection from the JSON export via
     `bulk_create_entries`.

## Known limitation (important)

Export → re-import does NOT preserve entry ids: `bulk_create_entries` mints
new ids, so **relation values pointing at old ids must be remapped** (old→new
map from the export's `id` column vs the import results). An
`import-with-ids` mode is the tracked fix (docs/subsystems/01). Until then,
restore relation-heavy projects via Neon PITR, not exports.

## Cadence suggestion

Before any destructive schema change on a real client project: download the
manifest + entries exports first (three clicks). Neon PITR handles the rest.
