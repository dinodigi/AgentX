# Plugins

This folder holds the **plugin definitions** — the readable source for every plugin in the catalog. A plugin is ONE installable unit declaring up to three ingredients: **structure** (a content model the AI reconciles into a project), **tools** (MCP verbs it unlocks), and **guidance** (how the AI operates it), plus **acceptance** criteria.

Full type + system logic: [`lib/plugins.ts`](../lib/plugins.ts) (`PluginDef`, `effectiveCatalog`, `enable/disable`, DB-backed authoring, operator overrides).

## The files here

| File | Plugin | Kind | How it ships |
|---|---|---|---|
| `seo.ts` | `seo` — SEO agent | first-party, tool-carrying | **built-in** — compiled into the app (`PLUGIN_CATALOG` in `lib/plugins.ts`) |
| `contact-forms.ts` | `contact_forms` | first-party, structure-only | **built-in** |
| `countryside-crm.mjs` | `countryside_crm` — client CRM | first-party, client case study | **DB-seeded** — a data file loaded into `plugin_defs` via the seed script |
| `auth-kit.mjs` | `auth_kit` — DIY user management | first-party, credential-free by design | **DB-seeded** — `node --env-file=.env scripts/seed-auth-kit-plugin.mjs` |
| `notification-kit.mjs` | `notification_kit` — in-app notifications | first-party, pairs with auth_kit | **DB-seeded** — `node --env-file=.env scripts/seed-notification-kit-plugin.mjs` |
| `booking.mjs` | `booking` — no-double-book slots | wave-1 BASE (provides: booking) | **DB-seeded** — `node --env-file=.env scripts/seed-base-plugins.mjs` |
| `waitlist.mjs` | `waitlist` — signups → invites | wave-1 BASE (provides: waitlist) | **DB-seeded** — same script |
| `feedback-wall.mjs` | `feedback_wall` — user feedback triage | wave-1 BASE (provides: feedback_wall) | **DB-seeded** — same script |
| `media-gallery.mjs` | `media_gallery` — publishable albums | wave-1 BASE (provides: media_gallery) | **DB-seeded** — same script |

## Two delivery mechanisms

1. **Built-in** (`.ts`, typed `PluginDef`) — imported by `lib/plugins.ts` into `PLUGIN_CATALOG`; versioned with the app binary. Use for core, always-present plugins.
2. **DB-backed** (`plugin_defs` table) — global rows (operator/seed-authored, first-party) or per-project private rows (authored by an agent via the `define_plugin` MCP tool, visible ONLY to that project). This is how client/bespoke plugins ship WITHOUT touching the platform binary. The `countryside-crm.mjs` def is seeded global via:

   ```
   node --env-file=.env scripts/seed-countryside-plugin.mjs
   ```

The **effective catalog** a project sees = built-ins + global DB defs + its own private defs, with operator activate/price overrides applied (`effectiveCatalog` in `lib/plugins.ts`).

## Adding a plugin

- **Core/first-party built-in** → add a `.ts` file here exporting a `PluginDef`, import it into `PLUGIN_CATALOG` (`lib/plugins.ts`). Add a smoke test.
- **Client/bespoke, or something you want swappable without a deploy** → author a `.mjs` data file + a seed script (global), or use `define_plugin` at runtime (project-scoped). Baseline field defs are validated on author; `workflow`/`publicFilter`/`access`/`events` on a baseline collection validate when the AI applies them via `define_collection`.

Tests: `scripts/smoke/67-plugins.test.mjs` (lifecycle), `78-plugin-catalog-db.test.mjs` (DB catalog + Countryside end-to-end), `68-seo-plugin.test.mjs`.
