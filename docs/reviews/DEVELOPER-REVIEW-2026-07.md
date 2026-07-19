# Developer Review — July 2026

**What this is:** the raw notes/critiques from a developer building on and reviewing the Pluggie platform (via the Stallion Construction project). Recorded as-is, in the reviewer's framing — this is *his* input, not our conclusions. Our point-by-point response + decisions live in a separate doc: [ARCHITECTURE-RATIONALE.md](ARCHITECTURE-RATIONALE.md).

Status tags in brackets are ours, added only so the reader knows what's already actioned.

---

## Part A — Field report (tactical: what worked, what broke)

### Upgrades he put to work
- `html` on the email action (custom HTML body + `{{field}}` interpolation) — branded inquiry emails through Pluggie's own connector; let him drop a redundant Resend key.
- `array` + `group` field types (repeaters: scalars, groups, or typed blocks; nested groups) — the whole `pages` collection.
- Typed blocks (`array:{blocks:[…]}`) — modeled the homepage's 11 real sections 1:1.
- `indexed` field flag — marked `status`, `published`, `sort_order`, `published_at` for scale.
- Plugins subsystem (`list_plugins` / `get_plugin` / `enable_plugin`, the SEO plugin) — ran a live SEO audit (87/100) + the `seo` group model.

### Capabilities he leaned on heavily
- `aggregate_entries` (count/sum/group-by without fetching rows) → admin dashboard stat cards in one round trip.
- `transact` (atomic multi-op with `$ref` cross-references) → the gallery migration.
- computed fields (`now`) → server-stamped `created_at` / `sent_at` / `received_at`.
- Workflows (actor-gated status state machine) → inquiries `new → contacted → closed`.
- On-demand image resizing (`/assets/{id}/image?w=…`, cached a year).
- Token scoping (delivery vs full/MCP) — the basis of keeping the admin secure.
- Available-but-unused: `get_audit_log`, `get_changes`, `list_entry_versions`/`restore`, `search_entries`, before-write hooks + `test_hook`, `get_client_code`.

### Limitations & bugs he reported
- 🔴 **A field retype silently didn't apply.** Redefined `projects.gallery` from `text → array`. Call returned `ok:true`, `changes.retyped:[{gallery,text→array}]`, `affectedEntries:11` — but `describe_collection` afterward still showed `type:"text"`, and a `transact` writing arrays failed `Expected string, received array`. Reported as applied but wasn't; backed off safely (galleries stayed JSON-string). Data-integrity concern. **[FIXED 6dceefa — root cause was multi-instance cache staleness, not the retype; TTLs added.]**
- 🟠 **Typed blocks can't nest a repeater-of-groups.** A block can't contain an array-of-group, so repeating cards (services, FAQ, hero slides, area cards) had to be parallel index-aligned scalar arrays (`titles[]`, `descriptions[]`, `hrefs[]`). Works but fragile — one wrong index desyncs a card. Ask: allow one level of group-array inside a block, or let a block field reference another collection. **[PLANNED — v2 Track 1: relations inside blocks. Held: re-allowing repeater-in-repeater.]**
- 🟠 **The email action has no `from`.** Locked to the connector's single `fromEmail`; couldn't do per-sender inbox replies through Pluggie — used Resend's API directly. Ask: add `from` (validated allow-list) + `reply_to`/`cc`/`bcc`. **[PLANNED — v2 Track 2a.]**
- 🟠 **No inbound email.** Pluggie sends, can't receive; customer replies can't thread back natively. Built his own `/api/inbound` webhook + `inbound_messages` collection. Ask: native inbound (route → webhook or collection). **[PLANNED — v2 Track 2b.]**
- 🟡 **Delivery-scoped token → opaque MCP failure.** A delivery-scoped token on the MCP endpoint returned bare `Unauthorized` (not JSON), breaking response parsing. Asks: (1) structured `{error,code}` on auth failure; (2) document the delivery-vs-MCP token split prominently. **[FIXED 6dceefa (1); PLANNED v2 Track 4 (2).]**
- 🟡 **`score_page` graded a cold-start 503.** Scored Render's "Application loading" placeholder (still gave a misleading 44). Ask: skip/flag non-200. **[FIXED 6dceefa. Cold start itself is Render infra, acknowledged not Pluggie's.]**
- 🟡 **Query operators lack not-equal.** `where`/`publicFilter` only have `eq`/`contains`/`gt`/`lt`/`in`. Had to phrase visibility as `published eq true` (draft-by-default); no `ne`, no "published OR unset." **[PLANNED — v2 Track 3.]**
- 🟡 **Single-asset fields only.** `asset` is one file; galleries need a workaround. Ask: first-class multi-asset field. **[Note: `array:{item:{type:asset}}` already exists — the cache bug blocked his attempt.]**
- 🟢 Polish: connector `fromEmail` (non-secret) not settable via MCP; intermittent `502 Bad Gateway` from MCP (transient, retried OK); `query_entries` says "No full-text search service" while `search_entries` exists. **[Last one FIXED 6dceefa; `fromEmail`-via-MCP held (operator surface); 502s watched.]**

---

## Part B — Architecture critiques (strategic)

Recorded verbatim in substance:

1. **"Every DB request goes through your server — this is a bottleneck."** Rendering a single page can make up to ~100 DB queries; scaling the server is a bad approach cost-wise, and downtime during autoscaling can crash apps.

2. **"Expose the DB over REST (PostgREST / Postgres REST API)."** Your system generates a token, passes it to the apps, and they query the DB directly over REST — decoupling the DB from your server so scaling becomes the DB provider's (Neon's) problem. Since it's still REST, it won't reintroduce the AI-hallucination problem that raw SQL would.

3. **"Rendering a page hits individual queries — you need batch."** A blog page has the main post query plus separate queries for menu, footer, sidebar, etc. — all individual calls.

4. **"Switch to a database friendlier for your data models."** The JSONB-blob storage suggests a document store would fit better.

5. **"You built a shittier WordPress."** (The framing critique: generic content table + custom fields + blocks + plugins ≈ WordPress, but smaller/less mature.)

---

*Response, reasoning, and decisions for every item above: [ARCHITECTURE-RATIONALE.md](ARCHITECTURE-RATIONALE.md).*
