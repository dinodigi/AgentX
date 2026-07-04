# Build Brief — Schema-Driven Admin Layer (working name: TBD)

> For Claude Code. This is a **product + scope brief**, not an architecture spec. You decide the best way to build it. The most important sections are **Scope discipline** and **Non-goals** — hold that line.

## One-liner
An MCP layer that lets an AI define a project's data structure, and gets back a working **branded, client-facing admin dashboard** and a **read/write API** for the live site — with zero admin UI hand-coded per project.

## The wedge (what makes this worth building)
Two things the incumbents (Directus, Replit, Sanity) don't do together:
1. **Builder-agnostic** — works over MCP from Claude Code / Cursor / any agent, not trapped inside one IDE.
2. **The client-facing admin is the product** — an agency defines a site's data via AI, then hands a clean branded dashboard to the client. The admin is a handoff artifact, not a byproduct.

## Who v1 is for
**Me (Currents Studio), first.** Success = my next client content site ships faster because I didn't hand-build a CMS/admin. Dogfood before it's ever a product for others. Design for one user (me) and my own infra.

---

## v1 scope (build exactly this)

**1. Schema registry**
- Store collection definitions as metadata; store entries as JSONB validated against them.
- 8 field primitives only — an AI composes schemas from these, never invents types:
  `text` · `richtext` · `number` · `boolean` · `date` · `enum` (with options) · `asset` (file ref) · `relation` (link to another collection)
- Validation must be strict enough that an AI can't corrupt stored data.

**2. MCP server (the interface for the AI)**
Tight, obvious tool surface — terseness matters more than completeness. Rough set:
- `list_field_types`
- `define_collection(name, fields[])`
- `describe_collection(name)`
- `create_entry` / `update_entry` / `query_entries`
- `upload_asset`
- Per-collection flags: `publicRead`, `publicWrite`
Tool descriptions must state the boundaries out loud (see Boundaries) so the AI doesn't hunt for tools that don't exist.

**3. Auto-generated admin dashboard**
- Renders from the schema registry — one input component per primitive (toggle for boolean, dropdown for enum, relation picker, asset upload w/ preview, etc.).
- Any collection the AI defines is instantly manageable. No per-project UI code.
- Brandable (name/logo/colors) since it gets handed to a client.

**4. Delivery API**
- `GET /v1/{collection}` — read content for the live site (relations resolved to `{id, label}`).
- `POST /v1/{collection}` — only when `publicWrite` is on. Covers contact/lead/signup forms. A form = a collection with public-write on; submissions appear in the same admin.

**5. Infra (dogfood version)**
- Connect to **my own existing Neon + Clerk** — do NOT build auto-provisioning / Clerk-for-Platforms yet. That's phase two.
- Asset storage: wire up one storage backend (R2 or similar) since `asset` needs somewhere real to live.

---

## Non-goals (do NOT build in v1 — these are the drift guards)
- ❌ No marketplace, no plugin system.
- ❌ No auto-provisioning of Neon/Clerk for other users, no multi-tenant hosting for strangers.
- ❌ No versioning, no i18n, no approval/publishing workflows, no real-time collaboration. (That's rebuilding a full CMS — deliberately out.)
- ❌ No notification/email engine — fire a **webhook** on public-write submissions and stop there.
- ❌ No form-field UI builder, no search service, no payments, no background jobs.
- ❌ No "platform for building complex apps" framing. This is a data + admin substrate. The app's business logic lives elsewhere.

## Known boundaries (state these in tool descriptions)
- **Authorization logic** (e.g. "a user can edit only their own record") lives in the app layer, not here. This system defines structure, not row-level rules.
- **No transactional / custom actions.** CRUD only. Anything needing atomic multi-step operations is the app's job.
- **Public-read scoping is required:** a public page must be able to read some fields/collections without leaking others (e.g. show available plots without exposing who claimed them). Design public read as per-collection or per-field, not all-or-nothing.

## Two open design decisions (flag, don't silently pick)
1. **Public-read granularity** — per-collection flag vs per-field visibility. Recommend per-field if cheap.
2. Later (phase two, not now): whether auto-provisioning goes into the **user's own Neon** (control-plane, low-risk) or **our org** (managed, we become the host). v1 sidesteps this by using my own infra.

## Environment / context (for alignment, not prescription)
My usual stack is Next.js + TypeScript + Drizzle + Neon + Clerk. Use it if it's the right call; deviate if you have a better one. One clean MCP server scoped per-project by a token — not a server per project.

## Definition of done for v1
I can, from Claude Code: connect this to a project, have the AI define a few collections, get a working branded admin I can log into, manage content, expose a read API the site consumes, and accept one public form. Then I use it on a real Currents site. That's it.
