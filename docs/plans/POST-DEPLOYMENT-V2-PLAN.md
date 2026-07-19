# Post-Deployment v2 Plan

**Status (2026-07-17 EOD): v2 CLOSED OUT — every track at a terminal state.** 11 code/doc items shipped live on pluggie.app in one run (c1851d8→d187a46+): ✅ Track 0 (0b F6 clamp, 0a storage guardrail, 0c audit retention, 0d error codes) · ✅ Track 1 (1a relations-in-blocks, 1b block library) · ✅ Track 2 (2a email senders, **2b inbound email**) · ✅ Track 3 (3b ne/exists, 3a batch reads) · ✅ Track 5 (audit_site) · ✅ Track 4 docs half (two-token-split in get_project_info, error-copy audited in 0d) + status-page setup doc.

**Terminal dispositions for the non-code remainder:**
- **2c email template management UI** — DEFERRED (nice-to-have; the send ENGINE + `html` templates work today via define_collection; a human template-builder is low-priority for an AI-authored product). Revisit on demand.
- **Track 4 positioning (landing page)** — the "not-WordPress" thesis is captured in `docs/ARCHITECTURE-RATIONALE.md`; APPLYING it to the marketing landing page is a DESIGN pass, not a code task. Handed to design.
- **Track 6 marketplace gallery + package-project-as-plugin** — DECISION-GATED: needs the catalog-storage call (in-code PLUGIN_CATALOG vs DB-backed) before the authoring tool + gallery UI. First-party-only direction is set; build once the storage decision is made.
- **Track 7 infra** — status page = OPERATOR config (`docs/runbooks/STATUS-PAGE-SETUP.md`, ~10 min external monitor); the rest (CDN purge-on-write, plane migration, tenant-migration fan-out, HA re-run, edge reader, Phase C) are TRIGGER-BASED — build when the specific pressure appears, not speculatively.

Original plan + full track detail below.

**Status:** planning (2026-07-17). **Source of truth for the next build phase** — carries everything open after v1.0 shipped + the Stallion dogfood triage, so nothing gets lost. v1.0 (all shipped, deployed, live-verified): CDN edge cache, caps/metering/stats/metered-rails, block types, plugin system, SEO plugin, Platform Settings console + tenant usage cards. Field report + same-day fixes: multi-instance cache TTLs, SEO non-200 guard, JSON MCP auth errors (6dceefa).

**Standing engineering rule (from the dogfood root-cause):** every `unstable_cache` MUST carry a `revalidate` TTL — `revalidateTag` only reaches the serving instance; tag-only caching is a single-instance assumption and we run N instances.

---

**VALIDATION ROUND 2 (2026-07-17) — claims re-verified against code:** F6 leak CONFIRMED (computed-ref validation checks sibling/non-computed/non-localized only — NO publicRead clamp exists, `lib/validation.ts` ~657); dataBytes cap = entries-only CONFIRMED (`assertDataBytes` sums `pg_column_size(entries.data)`); change-feed retention 30d CONFIRMED (`RETENTION_DAYS=30`, probabilistic prune, `lib/changes.ts`); **CORRECTION: audit_log has NO retention anywhere (grows unbounded — worse than the report's "~30-day both" claim)**; no `ne`/`exists` ops CONFIRMED (`OPS_BY_TYPE`, `lib/query.ts:37`); email action = to/subject/html only CONFIRMED (no from/reply_to/cc/bcc, `lib/events.ts`); no batch endpoint CONFIRMED (route glob); nested-relation ban CONFIRMED (`assertNestedAllowed`). 0d's "private-field write → 404" is report-observed — confirm exact code path at implementation.

## Track 0 — Hardening (scheduled within v2 — NOT an interrupt)

**Operator call (2026-07-17):** current tenants are small, operator-managed showcases — so Track 0 rides the roadmap rather than jumping it. 0b (a live leak) is still the recommended first pull when building resumes.

Source: the free-tier Hostile Agent capacity report (`C:\dev\Tests\Security\HAv1\freetier-report.html`, 2026-07-17). **Security posture came back A−** — 24 techniques clean (the HAv1 remediation HELD; graceful-degradation-under-load confirmed as a resilience win). The report also *validates* our Track 4 pricing direction (meter bytes + requests, keep reads free, byte-aware cap). Three actionable items, two of which hit PAID customers / live data:

**0a. Storage-wedge guardrail — CRITICAL (hits paid tenants too).** When a tenant DB fills its Neon limit, even DELETE fails (`could not extend file` — a delete needs scratch space); the tenant can read but can't write or self-recover, and the dashboard metric lags ~1h so there is NO warning. **Not free-tier-only — a Stallion-class paid tenant hits the same wall at a bigger number.**
- **Our shipped 4a dataBytes cap does NOT cover this.** It counts `pg_column_size(entries.data)` — entries only. The report shows the disk fills from **2.7× amplification**: entries 179MB + change-feed 240MB + audit-log 61MB. A project can be far under the entry-bytes cap while the real DB is wedged from log churn. **We measured the wrong number.**
- **Fix:** measure TOTAL tenant DB size (`pg_database_size` / summed table sizes) vs the plan's storage limit; **block writes at ~90% with a clear message BEFORE the un-deletable state**; surface real DB size in the console + tenant usage card (both currently show entry bytes, not DB size). Ship a recovery runbook for already-wedged DBs (`TRUNCATE entry_changes; TRUNCATE audit_log;` frees ~300MB of logs, not data).

**0b. F6 computed-field leak — security (live delivery-API exposure).** A public computed field (`template`/`slugify`) whose source is a `publicRead:false` field serves that private value verbatim on the anonymous delivery API — accepted at define time with no warning (repro in the report). **Fix:** at `define_collection`, clamp a computed field's effective `publicRead` to the MINIMUM `publicRead` of its sources, or reject public-computed-from-private with a clear error. Small, contained; do it soon.

**0c. Log retention as a plan lever (the 2.7× storage amplifier).** change-feed has a 30-day probabilistic prune (`lib/changes.ts RETENTION_DAYS`); **audit_log has NO retention at all (code-verified — grows unbounded)**. Add audit pruning + make both retentions tunable per plan (free = short retention or opt-in change-feed; paid = longer). Kills the biggest amplifier without touching real data. Pairs with 0a.

**0d. Error-code polish (also in the developer review — Track 4).** public-write of a private field → 403 `E_SCOPE` (currently 404); delivery cap-hit → 429/403 `E_CAP_REACHED` (currently 422). Cheap consistency fix.

**Also from the report (watch, not build-now):** broad full-text search is the one query shape that scales badly (557→1866→4063ms at 20k→100k→245k rows) — cost grows with match count; revisit if a real page leans on it. Untested-pending-external-inputs: email-relay, owner-IDOR positive path (needs 2 end-user JWTs), cross-tenant + CDN cache-key isolation (needs a 2nd project), Stripe checkout tampering.

---

## Track 1 — Blocks v1.1: relations-in-blocks + block library — **PRIORITY 1 (feature)**

**Evidence (Stallion build):** the one-level rule + no-nested-relations left the agent modeling repeating cards (services, FAQ, hero slides) as index-aligned parallel scalar arrays (`titles[]`, `descriptions[]`, `hrefs[]`) — exactly the fragility the rule exists to prevent. The architectural answer is NOT re-allowing repeater-in-repeater (held back, deliberately); it's letting a block point at a collection.

**1a. Relation fields inside blocks/groups.** Lift the v1 nested restriction for `relation` only (`assertNestedAllowed` in lib/validation.ts). Requires recursing the nested plumbing that currently stops at the top level:
- `buildEntrySchema` refChecks — collect nested relation refs for `verifyRefs`
- `resolveRelations` / `expandRelations` — resolve nested relation values to {id,label} (batched, same one-query discipline)
- F3 delivery projection + publicFilter gating for nested targets (same rules as top-level: target publicly readable, its row visibility applied)
- editor: relation picker as a leaf control in StructuredFieldEditor
- MCP docs: "repeating cards inside a block = a related collection + a relation field on the block"
Result: a `services` block = `{heading, items: relation → services}` — declarative, queryable, no parallel arrays.

**1b. Project-level block library.** Blocks are currently declared inline per array field. Add named, project-scoped block definitions (a `block_defs` store or a reserved `blocks` registry on the project) referenced by name from any collection: `array:{blocks:["hero","reviews_strip"]}` alongside inline defs. Reuse across collections + one place to evolve a shape ("declare a block as a template" — the exact dogfood + operator ask). Redefine rules mirror define_collection (a library block edit diffs against every collection using it).

---

## Track 2 — Email primitive completion

**2a. Outbound knobs:** `from` (validated ONLY against connector-verified/approved senders — never free-form; spoofing/deliverability), `reply_to`, `cc`, `bcc` on the email action. This single gap forced Stallion's reply flow out to Resend's raw API.
**2b. Inbound email (bigger, direction-setting):** receive + route (address → webhook or collection). Stallion composed their own `/api/inbound` webhook + `inbound_messages` collection — proof the primitives compose, and the demand signal. Design as a connector capability (Resend/SES inbound) feeding the existing events surface. Phase behind 2a.
**2c. (from v1 backlog)** email template MANAGEMENT layer — builder/library/admin form (the send ENGINE shipped 2026-07-15; management never built).

---

## Track 3 — Read ergonomics: batch endpoint + `ne`/`exists` operators

**3a. Cross-collection batch read** (from the developer review — the actionable strategic note). One request carrying several collection queries (`{queries:[{collection, where?, select?, limit?}, …]}`), each run through the SAME delivery gates (publicRead projection, publicFilter/identity, relation/asset resolution), returned together. Collapses a page's ~5 round trips → 1; DB never touched directly; every guarantee intact.
- **Caveat (rooted in the CDN work):** batch is a POST → not edge-cacheable. Public marketing pages are BETTER as individual GETs (nav/footer become free CDN HITs; batch would send all to origin). Batch's win is the AUTHENTICATED DASHBOARD (a user's own varied, uncacheable data). Document this so agents pick the right tool: public page → GETs+CDN; logged-in dashboard → batch.
- Touch: new `POST /v1/batch` route reusing the GET handler's gate/query pipeline per sub-query; bound the number of sub-queries; per-tenant rate-limit.

**3b. `ne` + `exists`/`unset` operators.**

"published OR unset" is currently inexpressible; agents contort models into draft-by-default. Add `ne` (accessor-based, null-safe semantics decided explicitly: does `ne:true` match unset rows? document the choice) and `exists`/`unset` (`data ? 'field'` / `IS NULL`) to `OPS_BY_TYPE` + `buildWhereParts` + publicFilter validation + MCP docs. Touch: lib/query.ts, validation of clauses, tools.ts docs, smoke test.

---

## Track 4 — DX / docs / legibility (small, high-leverage — from the review)

- **Positioning legibility (the "shittier WordPress" signal).** A competent dev's first read was "WordPress." That's a legibility failure, not an architecture one — the AI-native / headless / multi-tenant thesis isn't obvious at a glance. Docs + landing must LEAD with the three differentiators: (1) machine-authored via MCP (the AI defines the backend), (2) headless — we don't render, the AI/frontend does, (3) multi-tenant with provisioned + metered infra. Buildable as docs; also a marketing input. **Highest-leverage non-code item.**
- **Error + tool-copy is AI-UX.** The AI is the user; a confusing error/description is a product bug (his opaque 401 + the "no full-text search" contradiction broke his flow — both fixed). Audit every delivery/MCP error for the structured `{error,code}` envelope + a repair hint, and every tool description for accuracy.
- **Two-token split documentation** — delivery vs mcp scope, prominent in get_project_info / docs page / client-code output (bare-401 fixed; discoverability gap remains).
- **fromEmail via MCP?** Held (connectors = operator surface). Revisit narrowly for non-secret fields only.
- Monitor intermittent MCP 502s (transient/Render; watch, don't build).

---

## Track 5 — SEO plugin v2 (operator mode)

v1 advisor shipped + dogfooded (87/100 on a real site). v2 = APPLY fixes behind a confirm step: score → propose entry patches (seo group writes) → user confirms → update_entry batch → re-score to prove movement. Rides update_entry/transact; the confirm discipline mirrors define_collection's destructive-change gate. Also: sitemap crawl (score every page, not one URL) bounded + rate-limited.

---

## Track 6 — Plugin system v1.1 — **FIRST-PARTY ONLY (decided 2026-07-17)**

**Decision:** the marketplace is **ours to build and capitalize on** — every plugin is first-party (authored by us), curated, quality-controlled. **Third-party listings are explicitly parked for the far future** (they'd need a review pipeline, sandboxing, and rev-share — a whole trust surface we don't want yet). The moat meanwhile: a catalog of proven, dogfooded plugins.

- **Marketplace/gallery surface** — browsable gallery + "template" filter for structure-only plugins; catalog stays first-party/curated (in-code or DB-backed, but only WE write to it).
- **Plugin authoring = INTERNAL operator tooling** — "package this project as a plugin" (`exportProject` as the seed): after a real build proves a structure (e.g., Stallion → a "contractor site" plugin), one step mints it into the catalog. This is OUR catalog-growth accelerator, not a public submission surface.
- **Monetization lever (when wanted):** paid plugins per project can ride the existing platform-Stripe rails (enablement gated on payment) — pricing decision later, rails exist.
- More catalog entries as dogfood demands (booking, blog, portfolio…).

---

## Decision record — direct-DB REST (PostgREST/Neon Data API): REJECTED as default; opt-in read escape-hatch is future-optional (2026-07-17)

Proposal: mint tokens so apps query the DB directly over REST, decoupling from the app server so scaling is Neon's problem. **Two premises examined against code:**

- **"A page is ~1 query" — FALSE (my earlier claim was wrong).** No cross-collection batch endpoint exists; delivery is per-collection (`/v1/[collection]`). A multi-section page (post + nav + footer + sidebar + settings) is ~5 calls / 8–15 queries. **BUT** the repeated sections (nav/footer/sidebar) are identical per-visitor + rarely change = the MOST cacheable → ~100% CDN HIT = 0 origin queries (live-verified). The multi-call cost is already absorbed by the CDN precisely because those sections are cacheable; only the per-URL body reaches origin.
- **"Still REST, so no added AI hallucination" — true but beside the point.** AI-simplicity was A motivation for the interface, not the only one. Code shows the READ path also enforces per-field publicRead projection (toPublicView, JSONB-key filtering) + publicFilter/owner/org row gates; the WRITE path carries validation, writableBy, identity stamping, hooks, computed, workflows, caps, events, audit, change-feed, idempotency, metering. The interface IS the security + billing + logic boundary, not just an AI convenience.

**Reads vs writes split cleanly (the real finding):** reads are *potentially* portable (projection + row gates → a generated view+RLS per collection); writes are NOT (hooks/computed/workflow/events/caps/audit/metering have no DB equivalent). So the decoupling instinct only ever applies to reads.

**Why PostgREST specifically fights our model:** (1) fields are JSONB keys not columns (`entries.data jsonb`) — per-field publicRead needs a generated view per collection, regenerated on every define_collection, per tenant; (2) relations are JSONB string values not FK columns — PostgREST auto-embed can't resolve them without manual view JOINs; (3) shared sandbox plane = one RLS mistake is a cross-tenant breach; (4) **billing inversion (decisive):** metering makes every Neon query = CU-hours; the CDN makes repeat reads = $0; direct-DB REST bypasses the CDN so the highest-volume cacheable reads (nav/footer) become billed Neon compute — backwards from the cost goal.

**Conclusion:** don't expose the DB as the default path. The valid kernel — reads shouldn't require scaling Render — is already met (reads terminate at Cloudflare; Render is stateless + N-instance and handles only writes + cache-miss reads). Escalation path, guarantee-preserving, in order: CDN (SHIPPED) → ?include/?expand fewer-bigger-calls (exists) → **edge delivery reader** (read path as a CF Worker on Neon — Neon-adjacent, zero Render, KEEPS our interface + CDN, no per-tenant view codegen). A Neon Data API read endpoint could later be offered as an OPT-IN power-user escape hatch for a tenant's own heavy/uncacheable dashboard reads (managed plane only, reads only, their own DB) — never the default, never writes, never shared plane.

---

## Track 7 — Infra / platform hardening (carry-over)

- **Edge delivery reader (future scale lever)** — port the delivery GET path (projection + gates, read-only) to a Cloudflare Worker querying Neon over HTTP: DB-adjacent reads without Render, guarantees intact. Only when CDN-miss volume actually pressures origin.

- **CDN purge-on-write** (entry write → Cloudflare purge API) — only if 60s staleness ever bites; TTL is fine today.
- **Content migration between data planes** — managed provisioning is greenfield-only (content must be empty); build shared→dedicated migration for upgrading a live project.
- **Tenant-migration version fan-out** — schema-version tracking + orchestrated migration across all tenant DBs (today: lazy migrate-before-first-use only).
- **Re-run Hostile Agent** for a fresh security score (post-remediation verify; last score C/75 pre-fixes).
- **Phase C scale items** (only when volume demands): relation-label denormalization, index-backed-query guard, A3 keyset-on-custom-sort.
- **Delivery-read rate limit decision** (open from the security batch).
- **Status / uptime page (trust signal — addresses the reliability critique directly).** Source exists: `GET /api/health` already returns `{status, db, latencyMs}` (+`?deep`). Two surfaces, deliberately different:
  1. **Public status page — MUST be hosted OFF our infra.** A self-hosted status page is down exactly when you need it. Use an external monitor (UptimeRobot free / BetterStack) polling `/api/health` + `/api/health?deep`, with THEIR hosted status page on a `status.pluggie.app` CNAME. Near-zero cost, correctly decoupled, gives customers the GitHub-style uptime history that signals platform trust.
  2. **Operator health widget (internal, fine to self-host)** — a small console panel reading recent health + the per-project stats we already compute (Track 4c), for the operator's own at-a-glance view.
  - **Future product angle:** per-tenant status (each deployed site's uptime) as a customer-facing feature — parked until the platform page proves the pattern.

---

## Operator decisions (not code)

1. **Metered rates** — flip on in Platform Settings when priced. COGS known: Neon $0.106/CU-h + $0.35/GB-mo → suggested retail ~30¢/CU-h + 50¢/GB-mo (~3× margin).
2. **Neon org upgrade** — no urgency (Free = 100 projects × 100 CU-h each); upgrading is pure usage-billing (~$3/mo at current load) and removes the suspension risk — do it whenever.
3. **Cap numbers** — editable in Platform Settings; current defaults ~1000× above real usage.

## Parked (unchanged from v1.0)

- **Cross-project connection** — a product-path/pricing decision (workspace-billed cluster), not a feature bolt-on. Multi-plugin single projects cover most integrated-suite needs.
- **Repeater-in-repeater (incl. inside blocks)** — permanently held; the one-level rule stands. Track 1 is the answer.

## Suggested order

0. **Track 0 (hardening) — first pull when building resumes** (operator downgraded from interrupt: tenants are small, operator-managed showcases). Within it: 0b F6 leak first (live exposure, tiny fix), then 0a guardrail + 0c retention together (same storage story), 0d rides along.
1. **Track 1 (blocks v1.1)** — evidence-backed, unblocks the next real page build.
2. **Track 3a (batch read) + 3b (`ne`/`exists`)** — small, shapes data models + dashboard reads.
3. **Track 2a (email from/reply_to)** — small, completes the mail primitive's send half.
4. **Track 5 (SEO v2)** — proves the plugin loop end-to-end.
5. Tracks 2b/6/7 as pull demands.

**Health note:** this is a prioritized BACKLOG, not one cycle. Pull from the top; don't attempt all seven tracks at once. Track 0 is the only "urgent" bucket — the rest is paced feature work.
