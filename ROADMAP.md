# AgentX Roadmap

Vision: an MCP-native platform where an agent defines a project's data model and
gets back a branded client admin + delivery API — growing into a multi-tenant
platform where users bring their own infra as **connectors** (Clerk, Neon,
email) and extend the agent's tool surface with **plugins**.

## Design rules (apply to every phase)

1. **Declarative + self-describing** — every capability is visible through the
   tool surface; tool descriptions state boundaries out loud.
2. **Machine-readable errors with fix hints** — an agent must be able to repair
   its own mistake from the error text alone.
3. **Secrets are references, never payloads** — provisioned credentials stay
   server-side; the agent gets a reference id, not a key.
4. **Destructive = plan + confirm** — anything that loses data returns a plan
   first and requires explicit confirmation (Terraform-style).
5. **The strict-validation invariant never weakens** — no feature may bypass
   per-field public-read or schema validation (this is why there is no raw SQL
   escape hatch).

---

## Phase 0 — Shipped (v1 + projects system)

Schema registry (8 primitives) · MCP server · delivery API with per-field
public read · branded auto-generated admin (Tailwind v4) · R2 assets ·
project tokens · members/roles · in-app project creation · settings ·
generated API reference · metadata caching.

## Phase 1 — Agent-complete data layer (v1.1) ✅ DONE 2026-07-04

Closes the gaps that block a fresh agent session from fully operating a project.
All inside the original brief's boundaries.

- [x] 1.1 `list_collections` tool (discovery for fresh sessions)
- [x] 1.2 `delete_entry` tool + delete button in admin
- [x] 1.3 `delete_collection` tool — guarded: reports entry count + inbound
      relations, requires `confirm: true`
- [x] 1.4 Query filters — schema-validated `where` (eq/contains/gt/lt) on
      `query_entries`; delivery API filters restricted to public fields
- [x] 1.5 Sorting — validated `orderBy` (typed casts for number/date)
- [x] 1.6 Schema diff engine — added/removed/retyped fields + affected entry counts
- [x] 1.7 `define_collection` safety — destructive redefinition returns the diff
      plan and requires `confirm: true`
- [x] 1.8 `export_project` — full project manifest (collections + settings) as
      one JSON doc; download from settings
- [x] 1.9 `import_project` — apply a manifest (idempotent, uses the diff engine)
- [x] 1.10 Idempotency keys on `create_entry` (retried agent call ≠ double insert)

**Gate to Phase 2:** ✅ all 12 tools verified over live MCP round-trips.

## Phase 1.5 — Production hardening (v1.2) ← CURRENT

Experiment-driven fixes plus the security floor that identity (Phase 4) must
land on. Evidence: experiment/friction-log.md.

- [ ] 1.5.1 F2 fix — assets resolve to `{id, url}` in delivery + query_entries
- [ ] 1.5.2 F1 fix — `get_project_info` tool (delivery base URL + endpoint shapes,
      admin URL, branding, connector status later)
- [ ] 1.5.3 Scoped tokens — `delivery` scope (public read/write only) for sites;
      `mcp` scope required for the MCP endpoint. Sites never hold write-the-world keys.
- [ ] 1.5.4 Rate limiting on public POST (per token+IP sliding window)
- [ ] 1.5.5 Webhook reliability — retries with backoff + `webhook_deliveries` log
      (pulled forward from 3.3; a lost lead is the worst failure mode)
- [ ] 1.5.6 `publicFilter` — per-collection row visibility for delivery reads
      (closes the testimonials leak declaratively, no identity needed)
- [ ] 1.5.7 `get_entry` + `count_entries` tools
- [ ] 1.5.8 `bulk_create_entries` (seeding cost 30+ round-trips in the experiment)
- [ ] 1.5.9 `list_assets` / `delete_asset` tools

## Phase 2 — Dogfood + deploy (the acceptance test)

The brief's definition of done ends with "use it on a real Currents site."
Evidence from this phase decides Phase 4's scope.

- [ ] 2.1 Vercel project + production env (Neon/Clerk/R2 prod values)
- [ ] 2.2 Production smoke suite (scripted curl checks for MCP + delivery + gates)
- [ ] 2.3 Point a real Currents content site at the delivery API
- [ ] 2.4 Friction log — every wall hit during the real build, captured as issues
- [ ] 2.5 Token hygiene — rotate dev tokens, document handoff flow

## Phase 3 — Events & actions

Generalize the existing public-write webhook into a declarative event system.
Email is NOT hosted here — it becomes an action once the email connector exists (5.3).

- [ ] 3.1 Event model — `on: entry.created|updated|deleted` config per collection
- [ ] 3.2 Single emit point in the entries layer (MCP, admin, delivery all flow through)
- [ ] 3.3 Webhook action executor with delivery log (last N attempts, status)
- [ ] 3.4 Events section in settings + `define_collection` support
- [ ] 3.5 Event log table in admin (observability for clients)

## Phase 4 — Identity-aware access (BYO issuer)

The CMS→app-platform jump. Design locked 2026-07-04: **BYO auth issuer** — each
project configures its own Clerk instance (JWKS URL via the Connectors tab);
the delivery API verifies end-user JWTs against THAT issuer. Client users live
in the client's Clerk, never ours. The agent never sees keys — `list_connectors`
reports status; the publishable key (public by design) is all a site needs.
Rule *presets*, not an expression language.

- [ ] 4.1 Project auth config: issuer + JWKS URL (manual entry first; Connectors
      tab UI arrives with 5.2)
- [ ] 4.2 Delivery API verifies end-user JWTs against the project issuer
- [ ] 4.3 Rule presets per collection: read/write `public|authenticated|owner`
      + `ownerField` auto-stamped from the verified user id
- [ ] 4.4 Rules surfaced in admin, API reference, and tool descriptions

## Phase 5 — Connectors (BYO infra)

The control-plane model: users connect their own services; secrets encrypted at
rest, exposed to agents as references only.

- [ ] 5.1 `project_connectors` model + AES-GCM secret encryption (master key env)
- [ ] 5.2 Connector admin UI — connect, health check, disconnect
- [ ] 5.3 Email connector (Resend) → unlocks `send_email` event action
- [ ] 5.4 Clerk connector — per-project Clerk instance for the client site's end users
- [ ] 5.5 Neon connector (BYO database) — split: connection mgmt / migration
      runner / data-plane routing
- [ ] 5.6 Neon branching — preview environments ("branch, try migration, promote/discard")

## Phase 6 — Multi-tenancy (open the platform)

- [ ] 6.1 Workspace model — sign-up → workspace owns projects (extends project_members)
- [ ] 6.2 Isolation audit — every query provably project-scoped
- [ ] 6.3 Quotas/limits per workspace
- [ ] 6.4 Platform operator console (usage, health)

## Phase 7 — Plugins (extend the tool surface)

Deliberately coarse — refine after Phase 5 proves the connector model.

- [ ] 7.1 Plugin manifest format (tools contributed, connector dependencies)
- [ ] 7.2 Registry + per-project enablement
- [ ] 7.3 MCP tool proxying for plugin-contributed tools

---

## Explicitly rejected (revisit only with strong evidence)

- **Server-side functions / sandboxed code** — crosses the "CRUD only" boundary;
  a product unto itself. The app layer owns business logic.
- **Raw SQL escape hatch** — bypasses per-field public-read guarantees.
- **Hosted email engine** — email is a connector-backed action, never infrastructure we run.
