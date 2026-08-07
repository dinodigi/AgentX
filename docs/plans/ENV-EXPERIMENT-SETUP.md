# Experiment environment — a place to build compute without risking production

> **Living — written 2026-08-07.** An operator runbook plus the code-side prep.
> This is **ENV-1's first slice**, deliberately scoped to "somewhere safe to
> experiment", NOT to production-grade staging. What it does not cover is listed
> at the bottom so nobody thinks ENV-1 is finished.

## The question this answers

*Can the same `render.yaml` in the same repo serve a second environment off a
different branch, keeping `master → production` untouched?*

**Yes.** Each entry in `services:` carries its own `branch:` field, so one
Blueprint can drive `agentx` off `master` and `agentx-experiment` off
`experiment`. Every secret is already `sync: false`, which means Render holds it
per service in the dashboard — and that is exactly the isolation mechanism: the
same YAML, different values.

**But there is a gotcha that changes the recommendation.** Render reads the
Blueprint from ONE branch (the default — `master`). So a second service must be
declared in **master's** `render.yaml`, not on the experiment branch, or the
Blueprint sync will not see it and a later re-sync could try to remove it. And
per the OPS notes, **env changes already require a Blueprint re-sync** — meaning
every sync is a moment when production's own definition is being re-applied.

## Recommendation: create the experiment service MANUALLY, not via the Blueprint

For the first pass, add nothing to `render.yaml`. In the Render dashboard:
**New → Web Service → same repo → branch `experiment`.** A service that is not
part of the Blueprint is independent of it.

| | Manual service | In the Blueprint |
|---|---|---|
| Risk to production | **none** — prod's definition is never touched | every re-sync re-applies prod too |
| Setup time | minutes | edit + commit + sync |
| Codified / reproducible | no | yes |
| Easy to delete | yes | needs a Blueprint edit |

Codify it in `render.yaml` **later**, once the experiment has proved worth
keeping. Getting there is a five-line addition; doing it now buys nothing and
puts production's Blueprint in the blast radius of an experiment.

## Service settings

Match production except where noted:

```
Name           agentx-experiment
Repo           same
Branch         experiment
Region         virginia          # same as Neon us-east-1
Runtime        node
Plan           starter           # ~$7/mo. `free` sleeps after ~15 min idle —
                                 # acceptable for an experiment, and it means
                                 # cold starts. Your call.
Build          npm ci && npm run build
Start          npm start
Health check   /api/health
Auto-deploy    on                # every push to `experiment` deploys
NODE_VERSION   22
```

## The isolation checklist — this is the part that matters

Sharing any of the first four means you are not experimenting, you are
experimenting **on production**.

| Env var | Experiment value | Why |
|---|---|---|
| `DATABASE_URL` | **its own Neon DB** | Otherwise every define/write lands in production's control plane |
| `CONNECTOR_MASTER_KEY` | **its own, freshly generated** | ENV-1's rule verbatim: *sharing one master key is relabeling, not isolating.* Generate with `openssl rand -base64 32` |
| `APP_URL` | the experiment's own `.onrender.com` URL | Pins the MCP endpoint, `deliveryBase`, and the generated client's baked `DEFAULT_BASE_URL`. Leave it wrong and a generated client points at **production** |
| `R2_BUCKET` + `R2_PUBLIC_BASE_URL` | its own bucket | Or uploaded assets collide with real ones |
| `ADMIN_EMAILS` | same as prod | So you can sign in. Matched on the Clerk user's **primary** email |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | **may share** the same instance | Same user ids, so sign-in just works and no re-keying is needed. This is the one place sharing is fine, because Clerk holds no tenant data |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `_SIGN_UP_URL` | `/sign-in`, `/sign-up` | Static |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | same account, different bucket | Account-scoped keys are fine |
| `CRON_SECRET` | its own value | Only needed if you add a drain (see below) |

**OMIT ENTIRELY — do not copy these across:**

| Env var | Why omitting is safer |
|---|---|
| `PLATFORM_STRIPE_SECRET_KEY`, `PLATFORM_STRIPE_WEBHOOK_SECRET` | Production keys here could create **real charges** from experimental code. Unset = paid checkout refuses with a clear error and nothing else breaks |
| `NEON_API_KEY` | Unset = managed tenant-DB provisioning refuses cleanly. Set = experimental code can create **real sibling Neon projects** on your account |
| `CF_API_TOKEN` | Same shape — it can create real R2 buckets |
| `MARKETING_INTAKE_TOKEN` | Points at a production delivery token |

Every one of those degrades gracefully when unset — that is by design in the
Blueprint's own comments, and it is what makes omission the safe default.

## The database

**Do not reuse `pluggie-test`.** That is the smoke suite's DB; a ~600-test run
against it several times a day would sit on top of a long-lived experiment.

Create a **third Neon project** — or a Neon **branch** of it, which is
copy-on-write, instant and discard-free (the same primitive XVibe proposed in
wall `d42e248b` and QRY-4 adopted for project twins).

Then apply the schema **by hand** — `npm run db:push` is broken against Neon
PG18, which is a standing constraint, not a surprise:

```
db/migrations/0000_bootstrap.sql
db/migrations/0001_drift-check.sql
db/migrations/0002_token-scopes.sql
db/migrations/0003_oauth.sql
```

Run them in order against the new database. Tenant tables come up through the
platform's own migration gate on first project creation.

## The drain cron — skip it at first

`agentx-jobs-drain` is pinned to `branch: master` and wired to the `agentx`
service via `fromService`. **Leave it alone.**

The experiment only needs its own drain when you start testing things that
queue: delayed event actions, schedules, and eventually scheduled functions.
When that day comes, add a second cron whose `fromService` names
**`agentx-experiment`** — pointing it at `agentx` would drain production's queue
on the experiment's schedule.

Until then: no cron, no cost, and nothing ticking against production.

## Do not monitor it

Leave the experiment out of UptimeRobot. Three keyword monitors currently watch
production; a fourth on a service you are deliberately breaking is alert fatigue
by design.

## Prove it, do not trust it

```bash
node scripts/verify-isolation.mjs --experiment .env.experiment
```

Keep a local `.env.experiment` holding exactly what you put into Render, and run
that before the first real use. It is READ-ONLY — it only ever SELECTs — and it
asserts every invariant on this page: the database differs from production, the
master key differs, `APP_URL` is not production's, the four dangerous vars are
absent, the R2 bucket differs, and the experiment database is empty (production
holds 81 projects; a fresh experiment holds 0, which is the least ambiguous
evidence available).

Once the service is deployed, add the live probe:

```bash
node scripts/verify-isolation.mjs --experiment .env.experiment --url https://<experiment>.onrender.com --token agx_...
```

That asks the running service what URLs it reports, so a wrong `APP_URL` is
caught by the service itself rather than by inspection.

**Two things the script cannot check, and you must verify by eye:**

1. **A drain cron wired `fromService: agentx`** would run PRODUCTION's queued
   jobs on the experiment's schedule — real emails and webhooks to real
   customers. This is the worst available outcome. Do not add a cron yet.
2. **Clerk dashboard settings are SHARED** if you share the instance. Changing
   the session-token template (tempting, since MT-7 is about exactly that) would
   affect production too.

## Sequence

**Operator (you), ~30–45 minutes:**

1. Create the Neon database (or branch) and copy its connection string.
2. Apply the four migration files in order.
3. Generate a fresh master key: `openssl rand -base64 32`.
4. Create the R2 bucket and note its public base URL.
5. Render → New → Web Service → same repo → branch `experiment`, settings above.
6. Set the env vars per the checklist. **Omit the four.**
7. Deploy. Check `/api/health` returns 200 and `/api/mcp` (a bare GET) answers
   with the tool list — that GET is public by design and is the cheapest possible
   proof the service is alive and pointed at its own DB.
8. Mint an MCP token in the experiment console and connect a client to
   `https://<experiment-url>/api/mcp`.

**Then, in a fresh session on the `experiment` branch — Phase 0 first:**

Run `npm run verify` **before writing any compute code.** The failures are the
complete list of contract claims compute invalidates, derived mechanically rather
than remembered. Expect suite 110's self-check to fire on `CONN-3` (the registry
calls a generic third-party proxy *declined*, which compute makes false), and
108/109/114 wherever they pin *"no arbitrary code"*, *"no expression language"*,
*"never hosts or evaluates tenant code"*, *"no multi-entry orchestration"*.

Details, phases and the five open questions are in
[COMPUTE-EXPERIMENT.md](COMPUTE-EXPERIMENT.md).

## Local development on the experiment branch

Unchanged from today, and the rule stays: run the local dev server with
**`.env.test` only, never `.env`**. Local `.env` still points at production's
control DB and shares its master key — that is ENV-1's open finding, and it is
why a code runtime must never be pointed at it.

## What this does NOT do — ENV-1 is still open

- No separate **Clerk instance** (deliberately shared; fine because Clerk holds
  no tenant data).
- No `staging.pluggie.app` DNS — the experiment lives on its `.onrender.com` URL.
- No **seed data** tooling and no realistic fixtures.
- No `staging` **branch** and no promote path. The `staging` branch stays
  uncreated until it has a destination; when it exists it takes that name,
  because `render.yaml` and ENV-1's design assume it.
- No schema-sync automation — migrations stay hand-applied.
- Not production-grade: single instance, no monitoring, no backups.

ENV-1 remains 📥 H on the backlog. This slice makes compute explorable; it does
not make the platform safe to make mistakes in generally.

## Cost

One `starter` web service (~$7/mo) plus a Neon database. No cron, so no second
cron cost. Deleting the service and the database removes all of it.
