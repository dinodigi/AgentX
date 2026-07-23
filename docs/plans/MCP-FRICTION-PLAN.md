# Sprint — MCP friction: field-run fixes → frictionless connection

> **SPRINT PLAN** (operator decision 2026-07-23: this is its own sprint, not a
> rider on MT-1). Written 2026-07-23 from the Codex-test Replit run (8 wall
> reports, 00:12–00:49) + the onboarding/OAuth design discussion of 07-22.
> Status marks inline (⬜ / 🚧 / ✅). Predecessor:
> `SPRINT-2026-07-HARDENING.md` (shipped `371fe29`, `5768c5e`).
>
> Shape: Tracks A–C are the fast half (~1.5 days, every item traced to a
> verified field finding). Track D is the spine (migration batch → MT-1
> scopes → DX-6 OAuth). Ship A–C as soon as green — they stand alone; D's
> pieces land in sequence behind them.

## The field evidence (every claim verified before planning — nothing assumed)

The Replit session's verification stamps say platform `0d721e7` — **the
pre-sprint deploy**. Render's zero-downtime rollout kept the old instance
serving their long-lived session (connected 07-22 23:33) while the new deploy
answered fresh connections. MCP clients also cache `tools/list` per
connection. Both facts shape Track B.

| # | Report (deduped from 8 rows) | Verdict |
|---|---|---|
| 1 | "Delivery token not reachable through MCP" (×2) | ✅ **Already shipped** (TOK-1, `371fe29`) — their session predated the deploy. Zero token platform-events for Codex-test + both their delivery tokens console-minted proves they never saw the tools. |
| 2 | "Collection deletion reports success but stays visible" (×2) | ⚠️ **Confirmed as the config-staleness CLASS**, not a logic bug: single-instance repro converges in **624ms**; multi-instance serves the 15s collection-cache window. Sixth recorded instance of the class. → Track A |
| 3 | "searchable:true on richtext not picked up after redefine" | ⚠️ **Same class**: the GIN index is an *expression* index (never stale); the `search_entries` gate reads collection config through the same 15s cache. Single-instance: works after **807ms**. → Track A |
| 4 | "CORS preflight blocks X-User-Token" (×2) | ❌ **Contradicted at platform level**: `lib/cors.ts` allows `x-user-token`; live prod preflight on `/api/v1/<collection>` answers 204 with it. 8/9 v1 routes export OPTIONS (the 9th is `_health`, GET-only). Their browser saw *a* failure — almost certainly #5's wrong base URL, which a browser reports as a CORS error. |
| 5 | "Delivery API 404 for every endpoint and token" | ❌ **Requests never reached the platform.** Both Replit delivery tokens have `lastUsedAt = never` — the resolver stamps ANY resolution attempt. A bad token answers 401, not 404. Wrong base URL (relative paths against their own origin, or missing `/api`). Platform blameless — but the DX failure is real. → Track C |
| 6 | "Browser-safe public-read mode" (idea) | 💡 Real product idea (publishable-key / tokenless public reads). Big; parked with design notes. → BACKLOG (DX-7) |
| 7 | "Health check from MCP" (idea half) | 💡 `briefing.health` already exists in get_project_info; what's missing is a *delivery-surface* self-test. Folded into C2. |

Lesson repeated from the last sprint: **five of seven claims were misdiagnosed
by the reporter** (already-fixed, wrong-cause, or self-inflicted) — but every
one pointed at real friction. Reports are symptoms; verify, then fix the
system that produced the symptom.

### ⚠️ CORRECTION (2026-07-23, verifyConnection field run) — verdicts #4/#5 REVERSED

The C2 self-test, run live in the reporter's own Replit workspace, printed the
true cause: the generated client shipped
`DEFAULT_BASE_URL = https://connectors.replit.com/api/v1` — **Replit's MCP
proxy**, not the platform. Mechanism: `publicOrigin` trusts `x-forwarded-host`
when `APP_URL` is unset, and Replit's MCP proxy injects ITS host into that
header; `APP_URL` was in neither `.env` nor `render.yaml` (the memory note
"APP_URL pins MCP origin" recorded the intent; the var never reached Render).
So the agent's app faithfully used the client we generated — **the platform
was at fault**, my "requests never reached us, wrong base URL on their side"
verdict was RIGHT about the symptom and WRONG about the blame, and report #5
("documented base URL does not match the live host") was **correct**. Every
caller-facing URL (deliveryBase, admin URL, changes feed) served through a
Replit-proxied MCP session had the same poison.
**Fix:** `APP_URL=https://pluggie.app` added to `render.yaml` (✅ LIVE 2026-07-23 18:14Z — Blueprint auto-synced on push; verified by spoofed-header probe: connectors.replit.com in x-forwarded-host now yields a pluggie.app base). (Original note: operator must
re-sync the Blueprint for env changes to apply); header derivation remains the
dev-only fallback. Diagnosed BY the C2 tool this sprint built — the fix for
the misdiagnosis found the misdiagnosis.

## Track A — turn OFF the staleness class for agents (~half day)

The class has now bitten: retype-looked-unapplied (recorded in code), PLUG-3
applied-state (prevented), workflow-redefine suspicion (disproved but
plausible), Codex #2, Codex #3. Agents act within seconds of their own
mutations; a 15s convergence window guarantees this keeps happening.

- ✅ **A1 — MCP-surface correctness reads go FRESH.** `list_collections`,
  `describe_collection`, and `search_entries`' config gate read the DB
  directly on the MCP surface (precedent: PLUG-3's `listCollectionNamesFresh`;
  standing rule: correctness gates never read through a cache). Delivery +
  admin hot paths keep the cache — they are human-paced and volume-heavy.
  Cost: ≤1 extra control-DB read per MCP call, bounded by the 300/min cap.
  *Test: redefine→search and delete→list converge immediately even with the
  cache poisoned (simulate by pre-warming, mutating via raw SQL, reading).*
- ✅ **A2 — mutation results state their convergence honestly.** Where a
  surface CAN still lag (delivery API, admin, other instances),
  `delete_collection`/`define_collection` results say so:
  "other surfaces converge within ~15s". Kills the "success was a lie"
  perception that produced report #2's framing.

## Track B — live sessions must learn the platform changed (~half day)

- ✅ **B1 — platform notice on tool-surface change.** The briefing system
  (`briefing.notices`, shown once per project) gains a notice authored at
  deploy time when TOOL_DEFS changes: "new tools since your session started:
  mint_delivery_token, … — re-list tools". The Replit session called
  get_project_info mid-run and would have learned about TOK-1 *hours* before
  filing #1. Cheap version of BACKLOG OPS-2.
- ✅ **B2 — self-identifying credential results.** Every credential-shaped
  result names its project ("minted on **Codex-test**"). Direct lesson from
  the wrong-project mint of 07-22. One line per tool.

## Track C — the delivery on-ramp survives a browser dev (~half day)

- ✅ **C1 — authenticated 404s name what exists.** `GET /api/v1/nope` with a
  VALID token returns 404 + "no collection 'nope' — this project has:
  courses, lessons, …" (public names only, and only when authenticated — no
  anonymous enumeration). Codex burned a session on #5; this ends that class
  in one response.
- ✅ **C2 — the generated client ships a connectivity self-test.**
  `get_client_code` output gains a `verifyConnection()` (fetch first
  collection, limit 1) + a header comment with the equivalent curl. Answers
  report #7's "health check" ask on the delivery side: wrong base URL now
  fails in one obvious place, not as 404-everything mystery.

## Track D — the spine: scoped tokens → OAuth (the actual sprint)

Sequenced per the 07-22 design discussion (recorded under DX-6 in BACKLOG):

- ✅ **D1 — the migration batch** (schema half applied 2026-07-23 to BOTH DBs; resolveToken expiry ENFORCEMENT rides with D2 code) (hand-applied, one pass): `expires_at` +
  refresh support on `project_tokens` (OAuth prerequisite; today every token
  lives forever), TOK-2 cap headroom in briefing, PLUG-4 realized-names stamp.
- ⬜ **D2 — MT-1: scoped MCP tokens.** Scopes must exist before a consent
  screen can promise them, or consent is theater.

  ### D2 design (drafted 2026-07-23, pending operator sign-off)

  **Vocabulary — six scopes, aligned to the tool-group table in CAPABILITIES
  §2** (a consent screen reads them aloud; they must be explainable in one
  line each):
  | Scope | Grants (tool groups) | Consent line |
  |---|---|---|
  | `content.read` | Reads, search, aggregate, changes, export_entries | "read this project's content" |
  | `content.write` | Writes, trash/restore, upload_asset, import | "create and edit content" |
  | `schema.manage` | define/delete collection+block, set_locales, plugins | "change the content model" |
  | `automation.manage` | schedules, jobs, inbound, test_hook, refire | "manage automations" |
  | `tokens.manage` | TOK-1's mint/list/revoke | "issue site credentials" |
  | `observability.read` | deliveries, audit log, project info, client code | "see logs and project info" |

  **Storage:** `project_tokens.scopes jsonb NULL` — NULL = legacy full-access
  (grandfather, exactly like `expires_at NULL` = non-expiring). Ships in the
  D3 migration alongside the OAuth grant table so it is ONE more hand-applied
  pass, not two.

  **Enforcement point:** a single map `TOOL_SCOPE: Record<toolName, scope>` in
  tools.ts, checked at the top of `callTool` — same choke-point philosophy as
  A1's `mustCollection`. Unknown-tool and missing-scope answers reuse
  `E_SCOPE` with the needed scope named ("this token lacks schema.manage").
  `send_feedback` stays scope-free (the wall must hear from ANY token).

  **Invariants:** `tokens.manage` can never be held by a delivery token;
  a scoped token can never mint a token broader than itself (subset rule —
  extends TOK-1's strictly-weaker principle from scope-kind to scope-set).

  **Default sets:** console mints full-scope (today's behavior, explicit);
  DX-6 consent defaults to `content.* + schema.manage + observability.read`
  with automation and tokens.manage as opt-in checkboxes.
- ⬜ **D3 — DX-6: MCP OAuth.** Authorization-server metadata discovery,
  dynamic client registration, authorization-code + PKCE, consent screen that
  **names the workspace, lists its projects, and labels the issued token** —
  the wrong-project error class ends here because humans stop handling raw
  tokens. Issuance rides TOK-1's rails (hashed, parented, cascade-revoked,
  platform-evented).
- Target experience: `claude mcp add pluggie https://pluggie.app/api/mcp` →
  browser → pick project → building. Both amber boxes of the onboarding
  diagram deleted.

## Deliberately parked

- **DX-7 — browser-safe public reads** (Codex idea #6): tokenless (or
  publishable-token) GET for public fields. Interacts with CDN cache keys,
  rate limiting, and abuse surface — needs its own design pass. BACKLOG'd.
- **ENV-1 staging** — unchanged; OPS-4's diff pattern is its phase one.

## Wall reconciliation (operator clicks, or say the word)

- #1 rows (×2) → shipped, commit `371fe29`; #2/#3 rows → fixed-by Track A
  when it ships; #4/#5 rows → answered (platform contradicted, root cause
  user-side base URL — with the `lastUsedAt=never` receipt); #6/#7 →
  ideas noted (DX-7 / C2).

## Success criteria

1. An agent's own mutation is visible to its next MCP read, always — no
   convergence window on the authoring surface.
2. A session that outlives a deploy learns the tool surface changed.
3. A wrong base URL fails in one self-explanatory place.
4. (D) A new machine connects to a chosen project with one URL and a browser
   consent — zero token handling.
