# Pluggie (AgentX)

An AI-native backend platform: an agent defines a project's data model over
MCP and gets back a **branded client admin**, a **public delivery API**, and a
**tenant-isolated data plane** — no per-project admin code. Live at
[pluggie.app](https://pluggie.app) ([status](https://stats.uptimerobot.com/YSeB4QyizR)).

## Surfaces

| Surface | Route | Auth | Purpose |
| --- | --- | --- | --- |
| MCP server | `POST /api/mcp` | project MCP token | agents define schema, manage content, run tools |
| Delivery API | `/api/v1/{collection}` | delivery token | live sites read content / accept writes (Cloudflare-cached) |
| Admin dashboard | `/admin/**` | Clerk | branded UI for operators + client members |
| Marketing site | `/` | public | pluggie.app pages, dogfooded on the platform itself |
| Health | `/api/health` · `/api/v1/_health` | public | uptime probes (process+DB · delivery plane) |

## Repo map

```
app/                Next.js App Router
  (marketing)/        public site (pages, pricing, products)
  admin/              per-project admin + operator console (/admin/console)
  api/mcp/            the MCP endpoint (tool dispatch)
  api/v1/             delivery API (collections, assets, changes, checkout)
  api/health/         liveness/readiness probe
  api/{jobs,stripe,platform-stripe,inbound,admin}/  drains, webhooks, uploads
components/         React components (admin/, marketing/)
db/                 Drizzle schema — control DB + tenant tables (schema.ts)
lib/                domain logic (the heart of the platform)
  collections.ts      schema defs, destructive-change gate, workflows
  entries.ts          entry CRUD, validation, queries, bulk, cursors
  mcp/tools.ts        the MCP tool surface (defs + dispatch)
  plugins.ts          plugin catalog (built-in + DB-backed defs)
  data-plane.ts       tenant DB resolution (shared / managed Neon / BYO)
  caps.ts, usage.ts   sandbox caps + metering
plugins/            plugin definitions (seo, contact-forms, countryside-crm)
scripts/            seeds, one-shot migrations, contract dump
  smoke/              the smoke suite (~82 test files, run via npm run smoke)
docs/               all documentation — see docs/README.md for the story
infra/              deployed infrastructure code (cloudflare/ edge-cache worker)
middleware.ts       Clerk gate for /admin (token-authed APIs excluded)
render.yaml         Render blueprint: web service + job-drain cron (prod deploy)
drizzle.config.ts   Drizzle Kit config (control DB)
```

## Development

```
npm install
cp .env.example .env        # Neon, Clerk, R2, Stripe values
npm run dev                 # http://localhost:3000 (sessions often use --port 3100)
npm run verify              # tsc + smoke suite (needs the dev server running)
```

The smoke suite (`scripts/smoke/`) runs integration tests against a live dev
server using ephemeral projects — real data is never touched.

## Deploying

Pushing `master` auto-deploys to Render (`render.yaml`). Two hard rules:

1. **Always `npm run build` before pushing** — tsc alone misses Next
   route-file export rules.
2. **Never `next build` while a dev server is running** — they share `.next`
   and every request 500s until restart.

Schema changes: `npm run db:push` is broken against Neon PG18 — apply columns
by hand (see memory/ops notes).

## Where things are decided

- What the platform does today → [docs/CAPABILITIES.md](docs/CAPABILITIES.md)
- Why it's built this way → [docs/ARCHITECTURE-RATIONALE.md](docs/ARCHITECTURE-RATIONALE.md)
- What's next → [docs/BACKLOG.md](docs/BACKLOG.md) + [docs/plans/](docs/plans/)
- How to operate it → [docs/OPS.md](docs/OPS.md) + [docs/runbooks/](docs/runbooks/)
- The full doc story → [docs/README.md](docs/README.md)
