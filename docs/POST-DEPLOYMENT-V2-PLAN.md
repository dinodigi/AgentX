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

## Track 3 — Query surface: `ne` + `exists`/`unset` operators

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

## Track 7 — Infra / platform hardening (carry-over)

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
