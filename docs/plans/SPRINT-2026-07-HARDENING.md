# Sprint — Hardening & closing the agent loop

> Initiative plan — written 2026-07-22. Status marks inline (⬜ / 🚧 / ✅).
> Theme: fix what is actively costing money and risking outages, then close
> the loop the field reports say is broken.

## Why this sprint (all evidence, no theory)

- **2026-07-21: total production outage.** Neon's control-DB compute quota was
  exhausted (a ~300-test smoke session was a large share). The blackout was
  amplified by our own health check, which reports 503 when the DB is
  unreachable — Render then restart-looped every instance, so *every* route
  502'd, including static marketing pages that need no database.
- **The same health check is the monthly bill.** Constant polling keeps the
  control DB awake 24/7 (~180 CU-h/mo ≈ $19), which is essentially the whole
  Neon line. Fixing it roughly halves infrastructure cost (~$29 → ~$16/mo).
- **Two Codex findings** from the plugin poke run: no MCP path to a delivery
  token (so `get_client_code` emits a client that can't run), and `enabled`
  reading as `applied`.
- **Four Stallion findings** filed 07-20, still untriaged — one of which looks
  like the fifth instance of our recurring config-staleness class.

## Track 1 — Stop the bleeding (do first; ~1 hour)

- ⬜ **OPS-3 — health liveness/readiness split.** `/api/health` returns **200**
  with `{status:"degraded",db:"down"}` when the control DB is unreachable, so
  Render keeps the instance in rotation: static pages serve, APIs fail honestly
  per-request, the drain cron stays reachable. UptimeRobot still alerts (its
  keyword `"ok"` is absent from a degraded body). A genuinely hung process
  still restarts — no response at all trips Render's timeout.
  *Test:* simulate DB-down and assert 200 + degraded body + no `"ok"`.
- ⬜ **OPS-4 — dedicated test database.** Point the smoke suite at its own Neon
  project so test runs can never exhaust or bill production's compute.
  **⚑ Needs the operator:** create one Neon project and hand over its
  connection string; I do the env/CI plumbing and update the runbook.
- ⬜ **Purge orphaned test projects.** 178 planless `smoke-*` projects survived
  failed/interrupted suites. Harmless to cost (control DB is 41 MB) but they
  clutter the fleet view. Purge safely, then fix the leak: ephemeral cleanup
  must survive a failing suite.

## Track 2 — Close the agent loop (the Codex findings)

- ⬜ **TOK-1 — mint/rotate delivery tokens over MCP.** Two independent reports.
  The sharp version: `get_client_code` generates a frontend client requiring a
  delivery token that no MCP tool can produce — the platform hands out code it
  won't let you run. Privilege-DOWNWARD (MCP is already the master credential),
  so safe in principle; audit-stamp mints like the import escape hatch.
  *Test:* mint → the token works on delivery and is refused on MCP; audit row
  carries the actor; rotation invalidates the old one.
- ⬜ **PLUG-3 — `enabled` ≠ `applied`.** `list_plugins` gains an applied-state
  (`none` / `partial` / `full`, computed by checking baseline collection names
  against the project) plus an explicit `nextAction`. Also closes a Track C
  hole: we stamp the enabled VERSION but never whether the structure landed, so
  a never-applied plugin is indistinguishable from a fully-applied one in the
  session briefing.

## Track 3 — Clear the Stallion four

- ⬜ **SEO title length measured on HTML-encoded text.** A 60-char title with
  two `&` reports as 68. Decode entities before measuring. (~20 min)
- ⬜ **`delete_asset` blocked by TRASHED rows.** `E_BLOCKED` gives only an entry
  id, and the blockers were soft-deleted bookkeeping rows. Either exclude
  trashed rows from the reference count, or say "N of them are in trash —
  purge or empty_trash to proceed" and name the collections.
- ⬜ **Workflow actions don't fire right after a redefine.** *The headline.* A
  transition ~60s after `define_collection` produced no `entry.transitioned`
  event; the same transition later fired correctly. Hypothesis: the transition
  matched the OLD workflow config (cache lag) without erroring — the **fifth**
  instance of our config-staleness class, after the destructive gate, relation
  targets, the delivery create gate, the connector gate, and the provider
  registry. **Investigate before patching**; if confirmed, apply the standing
  rule (a correctness path must not read stale config).
- ⬜ **Thumbnail burst rate-limiting.** ~150 first-time derivative generations
  from one media grid trip the limiter and render as permanently broken tiles.
  Either pre-generate one small derivative at upload, or answer
  `503 + Retry-After` so browsers retry instead of failing hard.

## Deliberately NOT in this sprint

- **Blueprints (Plugin Phase 2)** — gated on a clean poke pass; the run is
  still in flight.
- **Feedback issues-layer, XVibe** — parked by operator decision.
- **MT-1 (scoped MCP tokens)** — the largest latent security gap (one
  all-powerful token bypasses row isolation). Too big to bolt on here;
  **nominate it to lead the next sprint.**

## Success criteria

1. A control-DB outage degrades the platform instead of blacking it out —
   provable by simulating DB-down and still serving the marketing site.
2. Monthly infrastructure cost roughly halves (control DB sleeps when idle).
3. Smoke runs touch no production database.
4. An agent can go from empty project → generated client → working delivery
   calls without leaving MCP.
5. `list_plugins` makes the enabled/applied distinction obvious.
6. The wall's `new` column is empty again, with each fix reproduced first.
