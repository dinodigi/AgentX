# Post-Deployment v2 Plan

**Status:** planning (2026-07-17). **Source of truth for the next build phase** — carries everything open after v1.0 shipped + the Stallion dogfood triage, so nothing gets lost. v1.0 (all shipped, deployed, live-verified): CDN edge cache, caps/metering/stats/metered-rails, block types, plugin system, SEO plugin, Platform Settings console + tenant usage cards. Field report + same-day fixes: multi-instance cache TTLs, SEO non-200 guard, JSON MCP auth errors (6dceefa).

**Standing engineering rule (from the dogfood root-cause):** every `unstable_cache` MUST carry a `revalidate` TTL — `revalidateTag` only reaches the serving instance; tag-only caching is a single-instance assumption and we run N instances.

---

## Track 1 — Blocks v1.1: relations-in-blocks + block library — **PRIORITY 1**

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

## Track 4 — DX / docs polish (small, high-leverage)

- **Two-token split documentation** — delivery vs mcp scope, prominent in get_project_info/docs page/client-code output (the bare-401 confusion is fixed; the discoverability gap remains).
- **fromEmail via MCP?** Held for now (connectors = operator surface). Revisit narrowly for non-secret fields only, with an explicit decision.
- Monitor the intermittent MCP 502s (transient/Render; watch, don't build).

---

## Track 5 — SEO plugin v2 (operator mode)

v1 advisor shipped + dogfooded (87/100 on a real site). v2 = APPLY fixes behind a confirm step: score → propose entry patches (seo group writes) → user confirms → update_entry batch → re-score to prove movement. Rides update_entry/transact; the confirm discipline mirrors define_collection's destructive-change gate. Also: sitemap crawl (score every page, not one URL) bounded + rate-limited.

---

## Track 6 — Plugin system v1.1

- **Marketplace/gallery surface** (catalog is in-code; a browsable gallery + "template" filter for structure-only plugins).
- **Plugin authoring** — compose a plugin FROM a project (`exportProject` as the seed): "make this project a template."
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

---

## Operator decisions (not code)

1. **Metered rates** — flip on in Platform Settings when priced. COGS known: Neon $0.106/CU-h + $0.35/GB-mo → suggested retail ~30¢/CU-h + 50¢/GB-mo (~3× margin).
2. **Neon org upgrade** — no urgency (Free = 100 projects × 100 CU-h each); upgrading is pure usage-billing (~$3/mo at current load) and removes the suspension risk — do it whenever.
3. **Cap numbers** — editable in Platform Settings; current defaults ~1000× above real usage.

## Parked (unchanged from v1.0)

- **Cross-project connection** — a product-path/pricing decision (workspace-billed cluster), not a feature bolt-on. Multi-plugin single projects cover most integrated-suite needs.
- **Repeater-in-repeater (incl. inside blocks)** — permanently held; the one-level rule stands. Track 1 is the answer.

## Suggested order

1. **Track 1 (blocks v1.1)** — evidence-backed, unblocks the next real page build.
2. **Track 3 (`ne`/`exists`)** — small, shapes data models fleet-wide.
3. **Track 2a (email from/reply_to)** — small, completes the mail primitive's send half.
4. **Track 5 (SEO v2)** — proves the plugin loop end-to-end.
5. Tracks 2b/6/7 as pull demands.
