# AgentX — Schema-Driven Admin Layer

An MCP layer: an AI defines a project's data structure over MCP, and gets back a
**branded, client-facing admin dashboard** + a **read/write delivery API** for the
live site — with zero admin UI hand-coded per project.

v1 is dogfood-scoped (one operator, your own Neon + Clerk + R2). See
[`build-brief.md`](build-brief.md) for the product brief.

## Architecture

One Next.js app, one Neon DB, scoped per-project by token:

| Surface | Route | Auth | Purpose |
| --- | --- | --- | --- |
| MCP server | `POST /api/mcp` | project bearer token | the AI defines schema + manages content |
| Delivery API | `GET/POST /v1/{collection}` | project bearer token | the live site reads content / accepts forms |
| Admin dashboard | `/admin/**` | Clerk | branded UI handed to the client |

### The 8 field primitives
`text · richtext · number · boolean · date · enum · asset · relation` — an AI
composes schemas from these, never invents types. Defined once in
[`lib/field-types.ts`](lib/field-types.ts).

### Key modules
- [`lib/validation.ts`](lib/validation.ts) — the "AI can't corrupt data" guard: a
  meta-schema for field defs + a runtime Zod compiler for entries. Shared by all three surfaces.
- [`lib/entries.ts`](lib/entries.ts) — entry CRUD, relation/asset existence checks, per-field public projection.
- [`lib/mcp/tools.ts`](lib/mcp/tools.ts) — the terse MCP tool surface; descriptions state the boundaries out loud.
- [`db/schema.ts`](db/schema.ts) — projects, tokens, collections, entries, assets.

### Design decisions (from the brief)
- **Public-read is per-field** (`publicRead` on each field). `GET /v1` returns only public fields.
- **Public-write is per-collection** (`publicWrite`). A form = a public-write collection; submissions fire a webhook and land in the admin.
- **Out of scope:** authorization/row-level rules (app layer), transactional actions, versioning, i18n, workflows, email, marketplace, auto-provisioning.

## Setup

1. `npm install`
2. Copy `.env.example` → `.env` and fill in your **Neon**, **Clerk**, and **R2** values.
   Set `ADMIN_EMAILS` to your email — platform operators see every project.
3. `npm run db:push` — create the tables in Neon.
4. `npm run dev`
5. Sign in at `/admin` and click **New project** — it mints the MCP token (shown once).
   (`npm run seed -- "Name" "#color"` still works as a CLI alternative.)
6. Copy `.mcp.json.example` → `.mcp.json`, paste the token, and connect from Claude Code.

## Before committing

```
npm run verify   # typecheck + smoke suite (needs the dev server running)
```

The smoke suite (`npm run smoke`) runs ~38 integration assertions against
localhost:3000 using ephemeral projects — real data is never touched. See
docs/runbooks/backup-restore.md for the backup story.

## Access model

- **Platform operators** (`ADMIN_EMAILS`) open every project.
- Everyone else needs a `project_members` row: `operator` (settings + content) or
  `client` (content only) — added from the project's Settings page.
- Unauthorized projects render as 404 to avoid leaking project ids.

## Per-project screens

- **Collections** — auto-generated tables + entry forms, per-field visibility badges.
- **API reference** — generated from the schema: endpoints, public fields, sample JSON.
- **Settings** — branding (name/color/logo), MCP tokens (mint/revoke), per-form
  webhooks, members.

## Try it (definition of done)

From Claude Code, with the MCP server connected:
1. `list_field_types`
2. `define_collection` — e.g. a `posts` collection (with a `relation` to `authors`) and a
   public-write `contact` collection (mix public/private fields, set `webhookUrl`).
3. `create_entry` / `query_entries` — round-trip; try a bad enum value to see strict rejection.
4. Log into `/admin/{projectId}` — manage content through the auto-generated forms; upload an asset.
5. `GET /v1/posts` — only public fields, relations as `{id,label}`.
6. `POST /v1/contact` — submission stored, webhook fired, visible in the admin.
