# Post-Deployment v1.0 Plan

**Status: BUILT 2026-07-17 — all code items 1–8 SHIPPED in one batch** (commits e11faad → 666ec6a): CDN edge cache (code halves), Track 4 a–d (byte cap, Neon usage pull, unified stats, metered rails), block types, plugin system, SEO plugin. Remaining: the operator-side list (Cloudflare setup, METERED_RATES, cap-number sign-off) — see the deploy notes. Original plan below, statuses inline.
**Baseline (deployed to pluggie.app, 2026-07-16):** security hardening, styled HTML email, **structured fields** (group/array repeaters, one-level, F2/F3-safe), the **scale layer** (`indexed` fields → expression indexes, index-backed pagination). The data model is now blob-per-entry + declared indexes + relations + one-level repeaters — Dari-shaped, EXPLAIN-verified.
**This plan = the next phase**, in priority order. Cross-project connection is explicitly parked (see end).

**North star:** Pluggie is the **content model / AI-native backend**. The website is built by the customer's AI + frontend on our data. We are not the renderer.

---

## Track 1 — Block types (the cohesive builder) — **PRIORITY 1**

**Gap (from the last update):** `sections` is a repeater of ONE shape. A real page wants a body of **heterogeneous** blocks — hero, features, testimonial, CTA — each with its own fields. This is the "flexible content / typed blocks" tier. It's a **content-model** feature (what Payload/Sanity/Contentful call blocks), NOT a website builder — rendering stays the frontend's job.

**Design — extend the `array` primitive we already shipped.** Today `ArrayField` (`lib/field-types.ts`) is `{ item: ArrayItem; maxItems? }`, where `item` is a scalar spec OR a group. Add a sibling:

```ts
// field-types.ts
interface ArrayField {
  type: "array";
  item?: ArrayItem;            // existing: uniform items (a repeater of one shape)
  blocks?: BlockDef[];         // NEW: heterogeneous typed blocks (exactly one of item|blocks)
  maxItems?: number;
}
interface BlockDef { name: string; label: string; fields: FieldDef[] }
```
Stored value for a `blocks` array: `[{ "_type": "hero", ...heroFields }, { "_type": "features", ... }]` — a discriminated union on `_type`.

**Rides everything structured fields already does — this is the reason we built that first:**
- **Validation** (`lib/validation.ts`): `valueSchemaFor` for an array gains a `blocks` branch → `z.discriminatedUnion("_type", …)`; `walkStructure` validates each block's `fields` and enforces the **one-level rule** (a block's fields are flat + scalar-arrays + relations — a block may not contain another block/repeater-of-groups, per `MAX_ARRAY_GROUP_DEPTH = 1`).
- **Delivery projection** (`lib/entries.ts` `projectStructured`), **write-gate** (`checkFieldWrites`), **nested asset resolution** (`collectAssetIds`/`replaceAssets`) — all recurse per the item's block type; the F2/F3 guarantees hold per block.
- **Visual editor** (`components/StructuredFieldEditor.tsx`): `ArrayEditor` gains an **"+ Add block"** menu (pick a block type) → `NodeEditor` renders that block's `fields`. Reorder/remove already there.
- **MCP** (`lib/mcp/tools.ts`): `define_collection`'s field schema + `list_field_types` docs teach the `blocks` shape so the AI authors page bodies.

**Why first:** it's the missing 20% that makes pages a real builder, it gives the SEO agent richer page structure to read, and it makes plugins far more valuable (a plugin ships its block types). Bounded — an extension of shipped primitives, no data migration (JSONB).

---

## Track 2 — Plugins (the one installable system)

**One system. There is no "template."** A **plugin** is the single installable unit. It declares any mix of three ingredients:
1. **Structure** — a declarative spec of collections + fields + relations + workflows + block types.
2. **Tools** — domain verbs that expand what the AI can *do*.
3. **Guidance** — domain AI-context so it customizes/operates faster.

A structure-only plugin (no tools) is what you'd loosely call a "template" — but it's just a plugin carrying only the structure ingredient, installed by the exact same mechanism. **"Template" is not a distinct system.** At most it survives as a **catalog label/filter** in the marketplace (browse structure-only starters) — never a second code path. One system, one install flow, one marketplace.

**Key architectural decision (declarative intent, AI-applied — NOT a blind stamp):**
A plugin does **not** imperatively stamp collections. It **declares intent + acceptance criteria**, and the **AI realizes it against the actual project** using the existing MCP tools. This:
- **adapts** (merge with existing collections, match naming, add project-specific fields),
- makes **multi-plugin projects compose cleanly** — the AI *reconciles* two plugins instead of blind stamps colliding,
- is discoverable: **"the AI pings the project, sees the available/enabled plugins, and draws on them on demand."**

Guardrail: the spec must be a **precise contract with acceptance criteria** (exact entities/relations/workflow states + tests like "a booking must relate to a customer; double-booking rejected"), not vague prose — so a *marketplace* install is reliable, not the AI's mood. Optionally cache a tested "known-good" baseline the AI starts from (reliability + adaptivity).

**Rooted in what exists:**
- **Structure spec** rides the **export/import manifest** — `lib/manifest.ts` (`exportProject`/`importProject`). A plugin's structure ingredient is essentially a manifest the AI applies.
- **Tools** ride the **MCP tool surface** — `TOOL_DEFS` + `callTool` (`lib/mcp/tools.ts`). This is the deferred **Phase 21 / plugins** work (`ROADMAP.md` "ON HOLD"; V0/V1 in `docs/plans/LAUNCH-PLAN.md`).
- **Multi-plugin per project** — a project stacks many plugins; needs per-project **plugin enablement** (a new table + admin surface) and **namespacing** (a plugin's collections are prefixed / the AI reconciles) so two plugins don't collide.

**Phasing:** (a) plugin format = {structure-spec, tools, guidance, acceptance-criteria}; (b) install = AI applies the spec (adaptive) with the manifest as the known-good baseline; (c) per-project enablement + the gallery; (d) authoring (the AI composes a plugin from a project — `exportProject` is the seed).

---

## Track 3 — SEO agent (the first plugin — NOT a standalone build)

**Framing:** the deliverable is the **plugin system (Track 2)**. The SEO agent is the **first plugin that ships on it** — it exists to prove the system works and seed the marketplace, not as a bespoke one-off. If the plugin system didn't exist we wouldn't build it standalone.

The platform's first plugin, tool-heavy — it proves the plugin model on real content. Concretely (see the SEO walkthrough): an autonomous agent that runs **audit → scorecard (evidence) → fix → re-score**, operating on the **content layer** (the `seo` group + block-type page structure), reaching into data via relations.

**Toolkit is ~80% existing MCP:** `query_entries`, `list_collections`, `get_project_info` (read), `update_entry` + `define_collection` (write the `seo` fields / add an `seo` group). **Net-new SEO tools:** `fetch_page` (crawl the live `<head>` — advisory), `score_page`, `generate_jsonld`, optional Lighthouse/CWV.

**Phases:** v1 advisor (audit + scorecard, read-only) → v2 operator (apply fixes behind a confirm step — the "hard-to-reverse → confirm" discipline from the security work). **Companion:** a frontend SDK helper (e.g. Next.js `generateMetadata()` reading the `seo` group) so a fixed field actually renders as a meta tag — that closes the loop from "we fixed the data" to "the page ranks."

Depends on: block types (richer page structure) + the plugin system (Track 2).

---

## Track 4 — Metering, caps & billing (per-project stats)

**Why:** Pluggie provisions per-tenant infra it *pays for* (managed Neon DB, R2 bucket), so COGS scales with tenant usage. This track makes usage **visible + billed per project** and keeps caps as the runaway-cost floor.

**DECISION (2026-07-17): move to USAGE METERING** — supersedes the earlier `caps.ts` "caps-not-metering" (flat price + abuse ceilings) decision. We bill per actual Neon/R2 usage with overage. **Caps are NOT removed** — they stay as the **safety ceiling** (a metered bill can still be run up by a runaway agent; caps cap the blast radius). Meter bills; caps bound.

**Already built (verified in code — don't rebuild):**
- Subscription billing per project — `lib/platform-billing.ts` (B3): platform Stripe, `PLAN_PRICING`, per-project `plan` + `billingStatus`, checkout/portal/webhooks.
- **Caps enforced across THREE dimensions** — `lib/caps.ts`: `assertEntryCap` (sandbox 1k / paid 250k entries), `assertCollectionCap` (20 / 500), `assertAssetCap` (100 MB / 25 GB). All wired at write time. *(Row-count, not bytes — see gap 2.)*
- **Per-project request metering EXISTS** — `lib/platform.ts` C2 surface folds `usage_daily` rollup + live `rate_windows` per project (`lib/ratelimit.ts` `rollupUsage`).
- Per-project content stats — `tenantContentStats` (`lib/data-plane.ts`): entries + assetBytes + lastActivity (fans out to tenant DBs).

**Gaps to close (metering model):**
1. **Meter Neon usage (4b) — ✅ verified viable, now build.** `lib/neon-api.ts` has NO usage code today; add it. Source: `GET /projects` per-project billing-period consumption (`compute_time_seconds`, `data_storage_bytes_hour`/`synthetic_storage_size`, `written_data_bytes`) — poll on the `agentx-jobs-drain` cron, snapshot + diff into a `usage_daily`-style table. Time-series `GET /consumption_history/projects` needs Neon Scale+ (not required to bill). No `data_transfer_bytes` per project (minor).
2. **Byte-size cap (4a) — small.** Caps already bound entries/collections/assets; the gap is that entries are capped by **row count, not bytes** (250k tiny rows ≠ 250k fat blobs in Neon storage cost). Add a `dataBytes` dimension + tune numbers. Fix the stale `// uncapped until B3` comment (code already contradicts it).
3. **Unified per-project stats surface (4c) — mostly consolidation.** Requests already computed (`platform.ts`); fold in entries + R2 bytes + Neon usage (4b) + **Cloudflare edge counts** into ONE per-project view (admin + API + operator console).
4. **Metered billing + overage (4d).** Stripe usage-based/metered prices; report metered quantities from 4b/4c; caps remain the hard ceiling above the meter.
5. **Pricing ≥ COGS** — validate metered rates + `PLAN_PRICING` base cover per-project (Neon + R2 + compute slice) with margin. Business input.

**⚠️ Billing-critical coupling:** with metering, the CDN's "meter reads Cloudflare, not origin counts" rule is **revenue-correctness**, not just accuracy — bill on origin counts while 90% is edge-cached and you under-bill. 4(b)/4(c) must read the edge.

**Depends on:** the data plane (metering fans out to tenant DBs via `tenantContentStats` + the Neon API) + the Neon consumption API (gap 1's gate).

---

## Related infra/scale track (in flight — not product features)

Separate from the product tracks but the same "safe-to-grow" gate:
- ✅ **App tier:** autoscaling on, 2 instances (fixes single-instance saturation + SPOF).
- 🟡 **CDN in front of delivery — CODE SHIPPED 2026-07-17; Cloudflare setup = operator step.** Full design + setup: **docs/runbooks/CDN-SETUP.md**.
  - **Design correction found in code:** there are NO anonymous delivery reads — every read is Bearer-token-authenticated and the URL does *not* identify the project (the token does). Same URL serves different tenants ⇒ a URL-keyed CDN cache would leak across tenants. The earlier "cache anonymous reads / bypass on token" framing was wrong.
  - **Shipped origin contract** (`lib/delivery-http.ts cachedJson({share})`): public reads (no `x-user-token`, no owner row-clauses) emit `max-age=0, s-maxage=60, stale-while-revalidate=300` + `Vary: authorization, x-user-token` + existing ETag; user-scoped reads, changes feed, POSTs, errors stay `no-cache`/uncached. Kill switch: `DELIVERY_EDGE_TTL_SECONDS=0`. Test: `scripts/smoke/63-delivery-cache-headers.test.mjs`.
  - **Shipped edge worker** (`infra/cloudflare/delivery-cache-worker.js`): caches only s-maxage-marked 200s, key = URL + SHA-256(token) (per-tenant slots, raw token never stored), serves 304s at the edge, `x-edge-cache` debug header.
  - **Operator TODO:** proxy pluggie.app through Cloudflare, deploy the worker, route `pluggie.app/api/v1/*` (steps + verification curls in docs/runbooks/CDN-SETUP.md). Assets already edge-friendly (302 → R2 public URL, 1-year immutable).
  - **Metering gotcha stands (revenue-critical under usage billing):** edge HITs never reach origin → Track 4 meter must read Cloudflare analytics; origin counts keep covering un-cached work.
- ⬜ **Data-plane hardening** — migration fan-out + version tracking across tenant DBs, content-migration between planes (currently greenfield-only), Neon project-limit strategy. See the data-plane analysis.

---

## Operator to-do (post-deploy, 2026-07-17 batch)

Everything code-side is shipped; these are the operator-side steps, in order of impact:

1. **Cloudflare CDN (activates item #1)** — ~15 min, steps + verification curls in **docs/runbooks/CDN-SETUP.md**: proxy pluggie.app (orange cloud, SSL Full strict) → paste `infra/cloudflare/delivery-cache-worker.js` into Workers → route `pluggie.app/api/v1/*` → curl-verify `x-edge-cache: MISS-STORED → HIT`. Until then the s-maxage headers are emitted but no edge caches them (harmless).
2. **Cap numbers sign-off (4a)** — `lib/caps.ts`: dataBytes sandbox **50 MB** / paid **5 GB** are my defaults marked `OPERATOR REVIEW` — confirm or change (one constant each).
3. **METERED_RATES (activates 4d)** — set the env on Render when pricing is decided, e.g. `{"computeCentsPerCuHour":12,"storageCentsPerGbMonth":8}` (cents; ≥ Neon COGS). Until set, metered billing is INERT — flat subscriptions unchanged. After setting: verify in Stripe test mode that a managed project's subscription gains the two metered items + usage.
4. **Neon org plan — NOT needed yet (corrected 2026-07-17).** Current Free plan: up to **100 projects**, each with its own **100 CU-h/month + 0.5 GB** allowance — at 14 projects (heaviest tenant ~10 CU-h MTD) there's large headroom. Free is **caps, not billing**: a project exhausting 100 CU-h is SUSPENDED until month reset — an outage for a paying tenant. **Upgrade trigger:** any project's console CU-h approaches ~80/month (turns suspension into overage billing), ~100 tenants, or >0.5 GB per tenant DB. (Paid also unlocks byte-hour storage accounting.)
5. **Glance the operator console** — `/admin/console` now shows per-project **content bytes vs cap** + **neon CU-h / db storage** on managed rows.
6. **Prod DDL: already applied** — `neon_usage_daily` (+ `data_transfer_bytes`) and `project_plugins` were created on the shared control DB during the batch (dev and prod share it). Nothing to run.
7. **(When ready) SEO plugin on a real project** — enable `seo` on Stallion, `score_page` its key URLs, and let the agent write the fixes; that's the dogfood for Tracks 2+3.

---

## Parked — cross-project connection (a product PATH, not a feature)

Connecting Project A ↔ B (a suite of internal apps that talk) is **parked** because it's a different **product path**, not a bolt-on:
- **Isolated projects** — hard tenant walls, per-project billing/data-plane. (Today.)
- **Connected cluster** — billed as a **workspace**, projects share a data plane and communicate.

And note: **multi-plugin projects (Track 2) already deliver the integrated-suite need for most cases** — HR + Sales + Finance as *plugins in ONE project* are one tenant, so they relate/communicate freely (relations + events) with no cross-project machinery. Cross-project stays only for the true-isolation case. The trust boundary, when it's built, is the **workspace** (`db/schema.ts` `project_members` / `workspaces`). Revisit deliberately with a pricing decision.

---

## Sequence & effort

**Committed order** (billing model = USAGE METERING, decided 2026-07-17; caps stay as the safety floor):

0. **✅ RESOLVED (2026-07-17) — Neon per-project consumption confirmed viable.** `GET /projects` project object exposes per-project billing-period consumption (`compute_time_seconds`, `data_storage_bytes_hour`/`synthetic_storage_size`, `active_time_seconds`, `written_data_bytes`) — **broadly available, poll + snapshot + diff** (ride the `agentx-jobs-drain` cron into a `usage_daily`-style table). The richer time-series `GET /consumption_history/projects` needs Neon **Scale+** (403 below) — NOT required to bill; upgrade later only for hourly history. Absent field: `data_transfer_bytes` (minor; R2 egress is free). **Attribution model is real — metering is buildable now, no forced Neon upgrade.**
1. **CDN / cache in front of delivery** — biggest read-load + Neon-COGS lever; ships first for immediate relief. **Committed rule: the meter reads Cloudflare analytics, not origin counts** — now *revenue-correctness* under metering, not just accuracy. Independent of caps.
2. **Track 4(a) — byte-size cap** — SMALL: caps already bound entries/collections/assets by count; add a `dataBytes` dimension + tune. Caps are the safety floor under the meter, not the biller.
3. **Track 4(b) — Neon usage pull** — per-project usage from the Neon API (gated by step 0); the metering data source.
4. **Track 4(c) — unified per-project stats** — requests already computed (`platform.ts`); fold in entries + R2 bytes + Neon (b) + Cloudflare edge counts into one view.
5. **Track 4(d) — metered billing + pricing-vs-COGS** — Stripe usage-based prices reporting quantities from 3–4; caps remain the ceiling above the meter.
6. **Track 1 — block types** — first product feature; bounded extension of shipped structured fields; no migration.
7. **Track 2 — the plugin system** — the real product build: one installable unit declaring structure + tools + guidance, AI-applied; rides the manifest + MCP surface. No separate "template."
8. **Track 3 — SEO agent AS the first plugin** — not a standalone build; it ships on the Track 2 plugin system to prove the model + seed the marketplace.
9. **Cross-project** — parked pending a product-path/pricing decision.

**Touch points (Track 1, ready to spec first):** `lib/field-types.ts` (`blocks` on ArrayField), `lib/validation.ts` (discriminated-union value schema + walkStructure), `lib/entries.ts` (projection/write-gate/asset recursion per block), `components/StructuredFieldEditor.tsx` (Add-block menu), `lib/mcp/tools.ts` (define_collection docs), `scripts/smoke/*` (block-type tests).
