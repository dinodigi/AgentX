# Plugin Bases Plan — focused bases, matured by dogfood, blueprints deferred

> Initiative plan — written 2026-07-20. Status marks inline. Companion
> ideation: [../PLUGIN-BASE-CATALOG.md](../PLUGIN-BASE-CATALOG.md) (~40 base
> candidates). Supersedes the earlier informal "plugin layer Phase 1" scoping.

## Why (evidence, not theory)

The wall's first weeks exposed three gaps in plugin v1 (install works; the
rest doesn't): plugins can't act (CSLP re-implemented ~1,600 lines of
operations incl. a compliance invariant), don't compose (two enabled plugins
claimed lead capture; our own kits both carry `users`), and don't update
(CSLP runs countryside v1.0 against a v1.1 catalog, silently). Full triage:
[../reviews/FEEDBACK-TRIAGE-2026-07.md](../reviews/FEEDBACK-TRIAGE-2026-07.md).

**Model decided in ideation (2026-07-20):** BASES own exactly one capability
(`provides`), declare dependencies (`requires`); BLUEPRINTS bundle bases via
`includes` + declared extension notes (never forks); one active provider per
capability, enforced at enable; updates are OFFERED (never pushed) and apply
as ordinary reconciles through the existing destructive gates; guidance/tools
already live-update from the catalog — only structure snapshots.

**Operator sequencing decision:** bases FIRST, matured through a dogfood
project that enables everything and pokes; blueprints are **Phase 2,
deferred** until bases stabilize. XVibe is parked and carries no weight here.

**Constraint removed (operator, 2026-07-21):** CSLP is a TEST project — no
migration/compat obligation to its applied state, ever. Ignore its drift;
countryside catalog refactors can be aggressive; the real client engagement
gets a FRESH apply (of the Phase 2 blueprint, most likely). CSLP doubles as
a second expendable poke surface.

## Phase 1 — bases that compose, self-maintain, and get poked (NOW)

### Track A — composition core (bases only) — ✅ shipped 2026-07-21
- `provides: string` + `requires: string[]` on PluginDef (optional — existing
  defs stay valid).
- Enable-time enforcement: one ACTIVE provider per capability; enabling a
  second provider names the conflict and requires an explicit swap. Enabling
  a plugin with unmet `requires` names what's missing (or auto-enables it —
  decide during build; lean auto-enable with a note in the response).
- **Grandfather rule (binding):** enforcement applies to NEW enable actions
  only. Existing enablements are never retroactively disabled or blocked
  (CSLP runs contact_forms + countryside today — stays exactly as is; at
  most a briefing note). Applied project state is NEVER touched by catalog
  changes — defs are recipes, projects are the baked result; only an
  explicit re-apply through the reconcile gates changes a project. Test:
  a pre-existing double-provider project keeps both active and functional.
- Store + `list_plugins` surface capability + requires; conflicts explained
  in the response, not discovered via 401s.
- Annotate the five existing defs (identity, notify, lead_capture, seo,
  countryside for now keeps its monolith def until Phase 2).
- Tests: provider conflict, swap flow, requires resolution, legacy defs
  without `provides` unaffected.
- NOTE: `includes`/notes/delta layering is **Phase 2** — nothing blueprint-
  shaped ships in this track.

### Track B — AUTO-1: declarative scheduled mutations — ⬜
- `define_schedule` gains a constrained DATA action: `{where[], guard[],
  transition?, set?{field: now|value}}` executed by the jobs drain — the
  countryside recycle sweep self-hosts (two wall demand signals).
- Closed vocabulary, no arithmetic/branching — this is deliberately the SEED
  of the verbs decision (Path B): what we learn here shapes the later
  plugin-verbs design doc. Verbs themselves are NOT in this plan.
- Tests: sweep transitions stale rows exactly once under concurrent drains;
  guards refuse; audit attribution.

### Track C — updates surface: drift + session briefing — ⬜
- Record applied plugin version at enable/apply time (today unrecorded —
  the CSLP drift was only detectable by hand).
- `get_project_info` gains `briefing`: plugin update offers (from/to/type),
  platform notices since last session (small `platform_notices` table +
  per-project last-seen stamp), health summary (connectors, failed
  deliveries, caps nearing). Contract instructs: start every session here;
  handle `attention` before new work.
- Update application = re-run reconcile (existing gates); nothing auto-applies.
- Tests: briefing shape; drift appears after catalog bump; notice appears
  once and clears after being seen.

### Track D — wave-1 bases + the poke project — ⬜
- Extract/new bases, seeded global with `provides`/`requires` from birth:
  - `booking` (extract from countryside — slots + no-double-book)
  - `waitlist` (generalize our marketing intake)
  - `feedback_wall` (FEED-2 — client-facing mirror of ours)
  - `media_gallery` (new; requested twice in the field)
- Hold the auth_kit→identity/teams split until Track A's `requires` exists
  (notification_kit will then depend on identity instead of smuggling users).
- **The poke project (operator-run):** one dogfood project with EVERY plugin
  enabled; the operator + agent exercise each base against its `acceptance`
  array and file friction through the (now-guarded) wall. Base defs iterate
  by version bump + reseed; drift notices from Track C tell the poke project
  to re-reconcile. This loop is the maturation gate for Phase 2.

## Phase 2 — blueprints (DEFERRED — do not start)

Trigger: wave-1 bases stable in the poke project (no wall friction across a
full poke pass) AND the operator calls it. Scope when it opens: `includes` +
extension notes (declared deltas, additive-first, overrides flagged) +
provenance + conflict lister on base updates + **countryside_crm rebuilt as
the first blueprint** — aggressively, with no compatibility choreography
(CSLP is a test bed; the real client gets a fresh apply of the blueprint).

## Later / adjacent (tracked elsewhere)

- Plugin VERBS decision (Path B vs C) — design doc after AUTO-1 learnings.
- PANEL-1 in-chat panels (MCP Apps) — after PLUG-2.
- Parked bases blocked on primitives — see catalog §Parked.

## Success criteria (Phase 1)

1. Two plugins claiming the same capability cannot both be active, and the
   error explains the swap.
2. notification_kit expresses its identity dependency via `requires` (no
   more minimal-users smuggling) once the split lands.
3. The recycle sweep runs on-platform with no external compute.
4. A catalog version bump surfaces in the next session's briefing on every
   enabled project, and applying it rides the destructive gates.
5. The poke project has every plugin enabled simultaneously with zero
   capability collisions and a green acceptance pass per base.
