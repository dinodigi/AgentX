# Backlog — open ideas, feedback & parked decisions

> **Living — last synced 2026-07-19.**

*Single source of truth for everything raised but **not yet decided or scheduled**.
Started 2026-07-12. Sources now include the agent feedback wall
([reviews/FEEDBACK-TRIAGE-2026-07.md](reviews/FEEDBACK-TRIAGE-2026-07.md) —
source `wall`); the design thinking behind the meaty ones is captured in the
detail sections below so nothing has to be re-derived when we pick it up.*

**This doc is not the launch gate.** Launch-execution items (C1 dogfood, ops,
legal, Stripe/Clerk keys, the checklist) live in [LAUNCH-PLAN.md](plans/LAUNCH-PLAN.md).
This is the idea/feedback pipeline that feeds *future* work.

## Lifecycle

Move an item left→right as it firms up:

| Status | Meaning |
|---|---|
| 🅿️ **Parked** | Raised; we haven't decided *whether/how*. Needs a decision. |
| 📥 **Backlog** | Decided we want it; not yet scheduled. |
| 🗓️ **Phased** | Assigned to a phase / next up. |
| 🚧 **In progress** | Being built. |
| ✅ **Shipped** | Done (commit noted). |

Priority is **H/M/L**. Source: `audit` = readiness review, `dogfood` = real
build feedback, `design` = a design discussion here.

---

## Multi-tenancy & access
*The build confirmed this from the outside: `access.org` is enforced only on the
delivery API — MCP and admin are full-trust. This is the highest-value cluster.*

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| MT-1 | Scoped MCP tokens (per-collection / read-only / per-org) — today one all-powerful `mcp` token bypasses all row isolation | 🅿️ Parked | H | audit #1, dogfood |
| MT-2 | Org-scope the admin view, and/or fix the `get_project_info` "hand the admin URL to the client" copy (today that's a one-click cross-tenant exposure) | 📥 Backlog | H | audit #2 |
| MT-3 | Per-org composite unique (`unique:[orgField, field]`); stop the violation error leaking that a hidden row exists | 📥 Backlog | M | audit #3 |
| MT-4 | Project-level "require access rules on every collection" setting; require `confirm:true` when a redefine drops an existing `access` block. *(The **workflow**-drop half ✅ shipped `6256c51` — confirm-gated, fresh-read.)* | 📥 Backlog | M | audit #4 |
| MT-5 | Claim-based workflow transition actors (roles beyond coarse `mcp\|admin\|delivery`; `admin` currently includes client-role members) | 📥 Backlog | M | audit #5, wall |
| MT-6 | A way to **test** isolation from the build loop (mint/supply an end-user JWT, or an isolation harness) — today you can't verify it from MCP | 🅿️ Parked | M | dogfood |

## Write-path & delivery ergonomics

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| WP-7 | **Bulk write + delete on the delivery API.** Bulk ops are MCP-only, so a delivery-side client deleting/creating N loops N calls → 429. *(Batch **reads** ✅ shipped `POST /api/v1/batch` 2026-07-17; writes/deletes still loop. Related: MCP `bulk_create_entries` 100/call is chatty for big migrations — wall.)* (See detail.) | 📥 Backlog | H | dogfood, wall |
| WP-8 | Delivery-**read** rate limiting — decide whether public GETs get a budget (writes/search/transforms/checkout are limited today; reads ride the CDN). Open decision from the security remediation. | 🅿️ Parked | L | audit |
| WP-3 | Fix the hooks×bulk **contract contradiction**: `define_collection.hooks` says bulk is "refused"; the code runs the hook per item. One is a lie the agent will code against | 📥 Backlog | H | audit #8 |
| WP-1 | `Idempotency-Key` on delivery `POST` (exists on MCP `create`/`transact`, not delivery — backwards for retry-prone clients) | 📥 Backlog | M | audit #6 |
| WP-2 | `If-Match` (compare-and-set) on delivery `PATCH` (ETags are already served on reads; CAS is MCP-only today) | 📥 Backlog | M | audit #7 |
| WP-6 | Event webhooks: **fail closed** when no signing secret (today they send unsigned; hooks fail closed) + document event-webhook signing in the tool descriptions | 📥 Backlog | M | audit #11 + code |
| WP-4 | Document same-state workflow write semantics (no-op on `update_entry` vs `E_CONFLICT` on `update_entry_if` — currently unstated) | 📥 Backlog | L | audit #9 |
| WP-5 | Allow `after` (deferred) actions on workflow transitions, for parity with events | 🅿️ Parked | L | audit #10 |

## Secrets

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| SEC-1 | **Masked / write-only field type** — today any credential in a normal field is plaintext in DB/admin/MCP/export/versions/changes; blocks BYO-key-in-content patterns | 📥 Backlog | H | audit #12 |
| SEC-2 | Reject secret-shaped values (`sk_`/`rk_`/`whsec_`) in non-secret connector config fields + Clerk `pk_` shape check | ✅ Shipped `e59d13e` | — | dogfood |

## Query & scale

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| QRY-3 | **Publish the limits in the contract**: per-IP rate budget, `429` + `retry-after`, size caps. The mechanism exists (retry-after header) but isn't documented, so clients aren't rate-limit-aware. Ties to WP-7. | 📥 Backlog | H | audit #16, dogfood |
| QRY-1 | Absence operators (`ne`, `exists`/is-null); `gt`/`lt` + keyset cursors on the delivery read surface (delivery is equality + offset only). *(Both ops exist on MCP; wall asks for a first-class `neOrUnset` or a prominent docs callout for the `anyOf:[{ne},{exists:false}]` idiom → CONTRACT-1.)* | 📥 Backlog | M | audit #14, wall |
| QRY-2 | Async full export (dump to R2) for very large sets. *(The 5,000-row cap itself ✅ resolved `748d7f9` — `export_entries` pages a keyset cursor to a complete export; this item is now only about one-shot R2 dumps.)* | 🅿️ Parked | L | audit #15 |
| QRY-5 | **Reporting: date-bucketed aggregates (`granularity: day\|week\|month`) + a second `groupBy` dimension** — most CRM-style reports (pipeline by month, volume by rep by month) fall to client-side without it. Top of triage Track B. | 🗓️ Phased | H | wall |
| QRY-4 | Environment story (staging↔prod) + entry-level import/seeding (`import_project` is schema-only) | 🅿️ Parked | M | audit #17 |

## Data model

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| DM-1 | **Nested `list`/`object`/repeater field type** | ✅ Shipped 2026-07-15/17 | — | design, dogfood |
| | *Shipped as structured fields (`group`/`array`, one-level, recursive validation/projection, repeater editor) + heterogeneous **block types** with a `define_block` library. Remaining tail (relations-in-blocks polish, block library v1.1) tracks in plans/POST-DEPLOYMENT-V2-PLAN.md.* | | | |
| DM-2 | **Enum option renames with mapped backfill** (`optionRenames:[{field,from,to}]`) — today renaming a pipeline stage orphans stored values (`renames[]` is fields-only) | 📥 Backlog | M | wall |
| DM-3 | Counting/capacity constraint — "max N rows per composite key" (tour-slot capacity) has no declarative form; needs an external hook today | 🅿️ Parked | L | wall |

## DX & docs

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| DX-2 | Serve the contract + hook docs over HTTP (`/api/contract`, a public `hooks.md`) — today the contract references repo files an API consumer can't reach. Starter exists: `scripts/dump-contract.ts` → `docs/ai-contract.md` | 📥 Backlog | M | audit #19 |
| DX-1 | Add search + idempotency to the generated TS client (uploads/checkout/changes already covered) | 📥 Backlog | M | audit #18 |
| DX-3 | Public compliance page (encryption-at-rest / residency / SOC2 / GDPR posture); optional authenticated image-variant URLs | 🅿️ Parked | M | audit #20 |
| DX-4 | Timezone-aware schedules with DST (today UTC-only) | 🅿️ Parked | L | audit #21 |

## Agent contract & language ★
*The tool descriptions + `get_project_info` **are** the product for the AI
audience — agents plan against them and trust them over the code. A large share
of this cycle's "gaps" were contract failures, not capability gaps: the reviewer
audited from the contract and got things wrong; the dogfood agent missed a
**documented** upload endpoint and invented a keys-in-the-web-app hack. This is
the umbrella initiative to fix that surface end to end.*

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| CONTRACT-1 | **Full pass over agent-facing language** — every tool description, `get_project_info`, `list_field_types`, error copy, and the generated client. Accurate (never contradict code), complete (surface every capability), discoverable (the agent shouldn't miss an endpoint), self-correcting (errors name the fix), self-contained (no repo-only refs). Umbrella over WP-3, WP-6, QRY-3, DX-1, DX-2. (See detail.) | 📥 Backlog | H | design, dogfood, audit |

## Billing
*Two Stripe surfaces — don't conflate them. **Platform billing** (Pluggie
charging tenants $19/$29 per project) already does subscriptions. **Tenant
checkout** (a tenant's storefront selling to their own customers) is
payment-mode only — that's BILL-1.*

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| BILL-1 | **Tenant subscription commerce** — the tenant checkout (`/v1/checkout`) is hardcoded `mode:"payment"`, so tenants can't sell recurring/SaaS/membership products to their customers. A cluster (mode + lifecycle + portal + gated), not a flag. (See detail.) | 📥 Backlog | M | audit #13, dogfood |

## Product ideas (features, not fixes)

| ID | Item | Status | Pri | Source |
|---|---|---|---|---|
| NOTIF-1 | In-app **notification center** (shape decided — see detail). Ready to spec/build. | 📥 Backlog | M | design |
| NOTIF-2 | Notification channels: Slack/Discord, then email | 🅿️ Parked | L | design |
| OPS-1 | **Platform mailer** — shared dependency for NOTIF email + C5 ops alerting | 📥 Backlog | M | design |
| PLUG-1 | **AI-registered tools** (self-extending agent, V1) + endpoint governance. Post-launch. (See detail.) | 🅿️ Parked | L | design |
| BRAND-1 | Appearance **brand-kit → agent design tokens** (palette/type/tone the agent builds the site from) + live preview | 🅿️ Parked | L | design |
| CONN-1 | **Provider registry / swappable integrations** — Email = Resend \| Elastic \| SES, Storage = R2 \| S3, etc. Needs a category↔provider split (today connector `type` IS the provider), a provider adapter per category, per-provider config/secret schemas, and one-active-provider-per-category (unique index moves to `(projectId, category)`). The connectors UI is already category-grouped, so this is purely the architecture piece. Circle back when wiring a 2nd provider. | 🅿️ Parked | L | design |
| CONN-2 | **SMS connector** (Twilio-shaped) — `{type:'sms', to:'{{phone}}'}` event actions gated on consent flags; the countryside baseline ships `text_opt_in` with nothing to act on. First real second-provider case → do with CONN-1's category split. | 🅿️ Parked | M | wall |
| AUTO-1 | **Declarative scheduled data mutations** — `define_schedule` is actions-only (webhook/email); a constrained bulk-transition rule (cron + where + transition + stamp field) would let flows like the CRM recycle sweep self-host instead of depending on an external agent being alive. Triage Track C. | 📥 Backlog | M | wall |
| EMAIL-1 | **Email template management layer** — the styled HTML engine shipped (`8cbdf30`); the builder/library/admin form for managing templates did not. | 📥 Backlog | M | design |
| FEED-1 | **Feedback issues layer** (canonical issues + auto-attach dedup + smart `send_feedback` replies + ranked board) — designed, board mockup agreed. **ON HOLD by decision 2026-07-19: run the wall manually first.** Revisit when the same item arrives from 3+ projects or manual triage becomes ritual. | 🅿️ Parked | M | design |
| FEED-2 | **Client-facing feedback plugin** — a per-project feedback wall for a tenant's OWN end users (mirror of our internal loop). Explicitly requested as backlog, second priority. | 📥 Backlog | M | design |

---

# Detail — the meaty ones

## CONTRACT-1 · Agent-facing language pass ★ (design + dogfood + audit)

**Why this is a flagship, not a docs chore.** For the AI-integrator audience the
tool descriptions + `get_project_info` are the *entire* product surface — an
agent plans and builds against them, and **believes them over the code**. Across
this cycle almost every "gap" was really the contract hiding, contradicting, or
under-selling something the code already does:
- the reviewer audited from tool descriptions and reached several wrong
  conclusions (offset-only, no cursors, no backup, "CRUD-only client") — all
  *documentation* misses, not capability misses;
- the dogfood agent missed the **documented** `POST /v1/{collection}/uploads`
  endpoint and reached for a keys-in-the-web-app anti-pattern;
- a live contradiction (WP-3) would make an agent code to the wrong branch.

So this surface directly drives credibility with the exact audience the platform
is built for.

**Scope (the surfaces to audit):**
- `TOOL_DEFS` — all 42 tool descriptions + input schemas (`lib/mcp/tools.ts`).
- `get_project_info` — the orientation blob (URLs, boundaries, `deliveryApi.*`, `compute.*`).
- `list_field_types` + `COMMON_FIELD_CONFIG`.
- Error messages + codes — are they self-correcting (name the fix)?
- The generated TS client (`get_client_code`).
- Referenced docs (`hooks.md` …) — reachability (→ DX-2).

**The bar (principles):**
1. **Accurate** — never contradict behavior (WP-3 is a live violation).
2. **Complete** — every capability is discoverable (cursors #14, retention #15, limits/429/retry-after QRY-3, event-webhook signing WP-6).
3. **Discoverable** — the agent shouldn't need to already know an endpoint exists to find it. The "how do I upload / paginate / handle 429 / verify a webhook / sell a subscription" questions must be answered where an agent looks.
4. **Self-correcting** — every error names the fix (the codebase does this well in places; make it universal).
5. **Boundary-honest** — keep stating what the system does NOT do, so the agent never hunts for a missing tool.
6. **Self-contained** — no references to repo files an API consumer can't fetch.

**Concrete defect checklist (known instances — fold these in):**
- WP-3 — hooks×bulk contradiction (a lie in the contract).
- WP-6 — event-webhook signing absent from tool descriptions.
- QRY-3 — rate budget / 429 / retry-after / size caps unpublished.
- #14 keyset cursors (exist on MCP) not surfaced; #15 30-day retention buried.
- WP-4 — same-state workflow write semantics unstated.
- **Uploads discoverability** (this thread): add a line to `get_project_info`'s boundaries — *"web/site uploads use `POST /v1/{collection}/uploads` with the delivery token → an asset field; never embed R2 or MCP credentials in a client."*
- Whatever else a systematic **behavior-vs-description diff** turns up.

**Method + anti-regression:**
- Systematic pass: for each tool and each `deliveryApi` capability, diff *what the code does* against *what the contract says*; fix contradictions, add missing capabilities, sharpen discoverability + error copy.
- `scripts/dump-contract.ts` already emits the full contract — use it as the review artifact each release, and diff it when `tools.ts` changes so drift is caught.

**Sizing:** many small edits + one structural rethink of `get_project_info` (organize it around the questions agents actually ask). High value, moderate effort, low risk.

## WP-7 · Bulk write + delete on the delivery API (dogfood)

**What happened:** a client's `deleteLeads` fired ~50 raw `DELETE /v1/{collection}/{id}` calls in a tight loop and hit **429**. There is **no bulk-delete anywhere** (delivery *or* MCP), and **no bulk write on delivery at all** — `bulk_create_entries` is MCP-only. So any delivery-side batch (delete N, or the 500-create batch builder) must loop, and the durable rate limiter (20/60s/IP) stops it.

**The two real gaps:**
1. **No batch endpoint on the delivery surface.** Options: a `POST /v1/{collection}/bulk` (create/delete many, capped), or documented client-side batching guidance.
2. **Undocumented rate-limit semantics** (→ QRY-3). The 429 *does* carry `retry-after` and `E_RATE_LIMITED`, but it's not in the contract, so clients don't build rate-limit-aware retry/pacing by default.

**Fix shape:** ship a capped bulk delete/create on delivery **and** publish the limits + retry-after so a generated client can pace itself. Do them together — a bulk endpoint without documented limits just moves the wall.

## DM-1 · Nested / repeater field type (design)

**Gap:** the model is flat — a record is a bag of single scalars + one-to-one relations. No arrays, no nested objects. "Many owned sub-records" (hours, FAQ, tiers, bullets) forces either a rigid flatten, unstructured richtext, or a whole child collection + join.

**Recommended shape:** one `list` type whose `of` is a scalar **or** a fixed object (covers bullet lists *and* repeaters like business hours); optional standalone `object` for fixed groups (SEO, address). Constraints that preserve the flat engine: **one level deep, opaque leaf** (no filter/sort/`unique`/`computed` on nested — same rule `localized`/`richtext` already follow), `publicRead` all-or-nothing, bounded item count.

**Performance note (important):** embedded = **the fast path** — JSONB in the same row, one read, no join. It's *faster* than the child-collection alternative (which joins). It gives up native queryability on the nested data, not speed — and you can buy that back on demand with a **GIN index** or a **shadow projection** without adding a join. Same expression-index machinery the platform already uses for `unique`.

**Cost split (why it's a real feature, not a knob):** ~⅓ nested admin editor (UI), ~⅓ schema/validation/contract plumbing (recursive `define_collection`, `list_field_types`, generated-client types), ~⅓ the querying story you pick (leave opaque / GIN / shadow).

**Phasing:** fixed-shape repeater first; polymorphic **page-builder blocks** (sections of varying shapes) are a bigger, later tier.

**Open questions at build time:** sub-field types allowed (scalars only? asset/relation?); delivery visibility (whole-field vs per-sub-field); search over nested text; item cap + reorder; how the contract teaches nesting; localized-inside-a-list (probably out); migration when toggling a field to/from `list`.

**Decision rule for modelers:** owned by one record, edited together, small-N, not queried on its own → embedded `list`. A real entity, shared or queried independently → child collection + relation (exists today).

## NOTIF-1 · In-app notification center (design — shape decided)

**Decided:** audience *both, phased* — in-app center first, email later once OPS-1 (platform mailer) exists. v1 covers **new submissions, failed deliveries, cap & billing, agent destructive actions**.

**Shape:** one control-plane `notifications` table every producer writes to (delivery-failure path, caps check, billing webhook, suspend action, submission intake); a **bell + feed** in the top bar's slot (unread badge, mark-read, click-through). Channels (Slack/Discord, then email) become additional sinks off the same event — model the event once. It's the tenant-side mirror of the console's "needs attention." Ready to spec/build on a go.

## PLUG-1 · AI-registered tools (design — post-launch)

**North star (operator's words):** *"allow the agent to register plugins if they like."* That's **V1** — the agent registers a new tool at runtime pointed at the tenant's own signed HTTPS endpoint. It's the write-hook model generalized from "gate a write" to "add a verb"; same signing, same fail-closed, same **never-host-tenant-code** boundary.

**Layering:** V1 is the foundation → **blueprints** can carry tool defs (templates gain verbs) → a **V0 marketplace** becomes "publish a bundle of V1 tools." V2 (we host/run tenant code) stays out — different product.

**The crux to design carefully:** letting the *agent* choose where data flows is a data-exfiltration vector distinct from code execution (a prompt-injected agent could register a tool pointed at an attacker endpoint). Mitigation is **endpoint governance**, not sandboxing — default to **tenant/operator-pre-approved domains**, human-in-the-loop for anything outside them. Build it in from day one, not as a bolt-on.

## BILL-1 · Tenant subscription commerce (audit #13 + dogfood)

**First, the distinction** (verified in code):
- **Platform billing** (Pluggie's own revenue) already does subscriptions — `createSubscriptionCheckout` uses `mode:"subscription"` (`lib/platform-billing.ts`). Not this item.
- **Tenant checkout** (`POST /v1/checkout` → `createCheckoutSession`, `lib/stripe.ts:148`) is hardcoded **`mode:"payment"`**. One-time purchases only. This item.

**The gap:** a tenant building SaaS/membership/recurring products on AgentX can only sell one-off purchases to their customers.

**It's a cluster, not a mode flip:**
1. **Subscription-mode sessions** — `createCheckoutSession` gains `mode:"subscription"` when a collection is marked recurring; the existing `priceField` (`price_…`) just has to point at a *recurring* Price. Needs a Stripe Customer (email at minimum) for the recurring relationship.
2. **Subscription lifecycle** — today K4 maps one-time `checkout.session.*` → an order entry (pending→paid). Subscriptions need the recurring lifecycle (`customer.subscription.created/updated/deleted`, `invoice.paid/payment_failed`) → a subscription-shaped mapping (status active/past_due/canceled, current period, renewal) instead of a one-shot order flip. **This is the bulk of the work.**
3. **Customer portal** — subscribers must self-manage/cancel → a Stripe billing-portal session endpoint. *Pluggie's own billing lacks this too — build once, use for both.*
4. **Member-gated commerce (related, audit #13 tail)** — checkout requires public-read collections today, so gated/member-only products are impossible. Subscriptions are usually gated (subscribe → access), so this pairs naturally: allow checkout on non-public collections with an authenticated buyer.

**Sizing:** meaningfully bigger than one-time checkout — the recurring lifecycle + portal, not just the session mode. This is "the SaaS market" the review flagged.

---

## Recently shipped from this pipeline
- **DM-1 structured fields + blocks** (2026-07-15/17) — group/array primitives, repeater editor, heterogeneous block types + `define_block` library.
- **Feedback wall first triage → 5 fixes + 1 security fix** (`6256c51`, `748d7f9`, `b1000e6`, 2026-07-18): workflow-drop confirm gate, relation stale-read → E_VALIDATION, create-null symmetry, workflow import escape hatch (audit-stamped), export keyset cursor, MCP-token-on-delivery scope enforcement. Full story: [reviews/FEEDBACK-TRIAGE-2026-07.md](reviews/FEEDBACK-TRIAGE-2026-07.md).
- **Batch delivery reads** (`POST /api/v1/batch`, 2026-07-17) — the read half of WP-7.
- **Platform billing customer portal** (`0bf5fb0`) — a subscriber can self-manage/cancel via the Stripe Billing Portal from project Settings → Billing. (Proves the portal pattern BILL-1 #3 reuses for tenant-commerce subscriptions.)
- **SEC-2** — connector secret-shape guard (`e59d13e`).
- (Contract dump tooling `scripts/dump-contract.ts` → `docs/ai-contract.md` exists as the DX-2 starter; the contract is now regenerated as part of the ship ritual — see CLAUDE.md.)
