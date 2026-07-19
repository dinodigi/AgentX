# Architecture Rationale — response to the developer review

> **Durable — written 2026-07.** Reasoning ages slowly; verify cited code paths
> before leaning on specifics.

**What this is:** the reasoned, code-rooted response to [DEVELOPER-REVIEW-2026-07.md](reviews/DEVELOPER-REVIEW-2026-07.md). It doubles as the durable answer to "is our foundation correct?" so the question doesn't have to be re-litigated. Every claim below is checkable in the code (files cited).

**Fair framing up front:** the reviewer is competent and his *tactical* feedback was genuinely valuable — the field report caught a real data-integrity bug (multi-instance cache staleness), the SEO 503, and the JSON-error gaps, all now fixed. It's specifically the *strategic* "rip out the layer / switch the DB" instinct that misses two constraints. This doc explains which, and why.

---

## The one reframe that resolves everything

The reviewer is evaluating the system as a **conventional single-tenant SaaS app** — the Supabase/Firebase mental model, which is the sensible default for almost any modern build. In that model three things hold:

1. **The schema is fixed** — you write migrations; tables map to your domain.
2. **It's single-tenant** — one app, one database, you own it.
3. **The client talks to the DB directly** — Supabase *is* PostgREST + Postgres + RLS; there is no app server in the read path.

**Every one of his strategic critiques is correct — for that model.** Our system has two constraints that invert each conclusion:

- **Schema fluidity.** The backend is **defined by an AI at runtime, with no migrations** (`define_collection` via MCP). Collections/fields are created and changed on the fly. There are therefore no stable columns to expose, and the interface must be simple enough for a machine to author reliably.
- **Platform-owned, multi-tenant data plane.** Pluggie provisions and owns per-tenant infrastructure (Neon project per paid tenant, R2 buckets), meters it, and bills it. The interface is the security **and** billing boundary, not a convenience.

Hold those two facts and the review reads very differently.

---

## Point by point

### 1. "Every request goes through your server — bottleneck; ~100 queries/page"

**Half-true, and the true half is already solved.**
- The query-count observation is fair: there is no cross-collection batch endpoint, so a multi-section page is ~5 calls / 8–15 queries (nav, footer, sidebar, settings, post). *(My earlier "one query" was wrong — corrected.)*
- But the repeated sections (nav/footer/sidebar) are identical per visitor and rarely change — the **most cacheable** thing on the site. Behind the CDN we shipped (`lib/delivery-http.ts` `cachedJson({share})`, live-verified `x-edge-cache: HIT`), those are **0 origin queries**. Only the per-URL post body reaches origin.
- A delivery read is 1–3 tenant queries anyway (token/schema/config are TTL-cached; relations + assets are **batched**, not N+1 — `resolveRelations`). The "100 queries" figure describes a frontend making ~50 uncoordinated calls, which `?expand`/`?include` + the CDN already collapse.
- "Autoscaling crashes apps" was the **old single-instance** setup. The app is stateless and now N-instance autoscaled; reads terminate at the edge, so Render handles only writes + cache-misses — a small, bounded load.

**Decision: no change. The read-scaling concern is real and already met by the CDN + stateless scaling.**

### 2. "Expose the DB over REST (PostgREST) with generated tokens"

This is the Supabase reflex, and it collides with both constraints — rooted in code:
- **Fields are JSONB keys, not columns** (`db/schema.ts`: `entries.data jsonb`). PostgREST grants on columns; per-field `publicRead` (`toPublicView`, `lib/entries.ts`) filters by JSONB key. To expose it you'd generate a **view + RLS policy per collection, per tenant, regenerated on every `define_collection`** — re-implementing `toPublicView` + `gateRead` as SQL, and only for reads.
- **Relations are JSONB string values, not FK columns**, so PostgREST auto-embedding (`?expand`) can't resolve them without manual view JOINs.
- **The shared sandbox plane is many tenants in one DB** — one RLS mistake is a cross-tenant breach; today's tested security posture (HAv1) is entirely at the app layer.
- **Billing inversion (decisive).** Metering (Track 4b) makes every Neon query = CU-hours = money; the CDN makes repeat reads = $0. Direct-DB REST bypasses the CDN, so the highest-volume cacheable reads (nav/footer) become **billed Neon compute** — backwards from the cost goal.
- His "still REST, so no hallucination" point is true but beside the point: AI-simplicity was *a* reason for the interface, not the only one. Code shows it's also the projection + row-gate boundary (reads) and the entire hooks/computed/workflow/caps/events/audit/metering boundary (writes).

**Decision: rejected as the default path.** The guarantee-preserving way to get "reads off Render" is the **edge delivery reader** (read path as a Cloudflare Worker on Neon — our interface at the edge, keeps the CDN, no per-tenant view codegen). A Neon Data API *read* endpoint could later be an **opt-in escape hatch** for a tenant's own heavy/uncacheable dashboard reads (managed plane, reads only, their own DB) — never the default, never writes, never the shared plane. (Recorded in the v2 plan's decision record.)

### 3. "Pages hit individual queries — you need batch"

**His best idea — actionable, with a caveat.** No cross-collection batch endpoint exists today. We'll add one: a single request carrying several collection queries, each run through the *same* gates, returned together — 5 HTTP round trips → 1, all guarantees intact, DB never touched directly.
- **Caveat (from the CDN work):** a batch call is a `POST`, which the CDN can't cache. For a *public marketing page*, individual GETs are actually better — nav/footer/sidebar become free edge HITs; batch would send all 5 to origin. Batch's real win is the **authenticated dashboard** (a user's own varied, uncacheable data — nothing caches anyway, one round trip beats five).
- Mental model: **public pages → individual GETs + CDN (already optimal); logged-in dashboards → batch endpoint.**

**Decision: build the batch read endpoint (v2 Track 3).**

### 4. "Switch to a friendlier (document) database"

**No — and this is the strongest "keep it" case.** We already *are* a document store (JSONB blob per entry), but we depend on the relational half, in code:

| Feature | Code | A document DB would… |
|---|---|---|
| ACID `transact` w/ `$ref` | 23 tx sites in `entries.ts`, `withTenantTransaction` | weaken it (Mongo multi-doc txns late/costly; Dynamo caps 25 items; Firestore limited) |
| 24 FK cascades | `db/schema.ts` (`onDelete:"cascade"` ×24) | have **no** FKs — hand-rolled cascades in app code (we *had* that bug; FKs fixed it) |
| Relations as batched JOINs | `resolveRelations` | force denormalization → the "edit once, update in 5 places" problem we avoid |
| SQL aggregates | `aggregate_entries` | weaker aggregation model |
| Expression indexes on JSONB | the A2 scale work | lose "document flexibility *with* relational indexing" |

Postgres-JSONB is the **deliberate** choice (the Dari/Brightspot benchmark) — document flexibility *and* relational integrity, and the model was already stress-tested in the scale work and found sound. A document DB hands us the half we already have and takes the half our headline features (`transact`, relations, `aggregate_entries`, unique constraints) — and the entire Neon provisioning + metering + billing stack — depend on.

**Decision: no change. JSONB-in-Postgres is the correct fit, not a compromise.**

### 5. "You built a shittier WordPress"

The most loaded one — and worth answering precisely, because the *primitives* genuinely rhyme:

**Where he's right:** generic content store + custom fields + repeatable blocks + a plugin system *does* echo WordPress (custom post types + ACF + Gutenberg + plugins). Those are the right primitives for flexible content modeling — WordPress got them right, and so did Contentful/Sanity/Payload. And WordPress is vastly more mature, with an enormous ecosystem; for a human hand-building a standard site *today*, WordPress is more productive. That part is fair and worth saying out loud.

**Where the conclusion is a category error — four structural differences:**

1. **The consumer is a machine, not a human.** WordPress is built for people clicking in `wp-admin`. This is built for an **AI agent** to define and operate the backend over MCP — the controlled tool surface, the closed field-type vocabulary, the validation, "the AI pings the project and sees its plugins." You cannot point Claude at WordPress and have it reliably model a domain. Different *consumer* = different category, not a smaller version.

2. **It's a headless backend, not a renderer.** WordPress is a monolith that owns the frontend (themes, PHP rendering). This **explicitly does not render** — the AI/frontend builds the site; we're the content model + API. That's the Contentful/Sanity/Payload lane (headless), not the WordPress lane.

3. **It specifically AVOIDS WordPress's actual scaling flaw.** "Shittier WordPress" usually implies the `wp_postmeta` EAV problem — one *row per field*, so reading N fields is N joins/rows, which is what makes WordPress slow at scale. **We are not that.** Ours is **blob-per-entry**: one JSONB document per entry, all fields in one row, one read = one row, plus expression indexes on the fields you query (`db/schema.ts` + the A2 work). On the exact axis the jab implies — scale/performance — we are architecturally **better**, by design, because we chose the model *to avoid* the `wp_postmeta` trap. (This was an explicit design goal.)

4. **Multi-tenant with provisioned infra + billing.** WordPress is single-site (one install, one DB; multisite is a bolt-on). This provisions a database per tenant, meters usage, and bills it. WordPress has no equivalent, and its security (plugin-driven) is its weak point; ours is a formal, tested boundary (per-field `publicRead`, token scoping, row/identity gates, fail-closed hooks — the HAv1 work).

**The honest bottom line:** it's like calling an API-first commerce backend "a shittier Magento" — shared primitives, different category. The comparison only *lands* if you reject the thesis (AI-authored + headless + multi-tenant). If that thesis is the bet — and it is — WordPress structurally can't play on that field, and we deliberately dodged its one real scaling flaw. **The primitives rhyme because they're the correct primitives; the category is different.**

---

## Decisions summary

| # | Critique | Decision |
|---|---|---|
| 1 | Server is a read bottleneck | **No change** — CDN + stateless scaling already offload reads |
| 2 | Expose DB via PostgREST | **Rejected as default**; edge reader / opt-in read hatch instead |
| 3 | Pages make individual queries | **Build batch read endpoint** (v2 Track 3) — the actionable one |
| 4 | Switch to a document DB | **No change** — JSONB-in-Postgres is the deliberate, correct fit |
| 5 | "Shittier WordPress" | **Category error** — right primitives, different consumer/lane; we avoid the EAV flaw |
| A | Tactical bugs/gaps | Mostly **fixed (6dceefa)** or **planned (v2)** — see the review doc's status tags |

**Foundation verdict: correct.** Keep the architecture and the database. The reviewer's tactical eye was valuable; his strategic critiques come from a conventional-app lens that the two constraints (schema-fluid, multi-tenant-platform) don't fit.
