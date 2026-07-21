# Plugin base catalog — the composable vocabulary

> **Living — last synced 2026-07-20.** Ideation catalog for the base/blueprint
> plugin model (bases own ONE capability; blueprints bundle bases + domain
> glue; one active provider per capability). Feeds the composition-core work
> tracked in BACKLOG. Statuses: **live** (in the catalog today) · **extract**
> (refactor of proven code) · **new** (greenfield def) · **future** (blocked on
> a named dependency).

## What qualifies as a base

1. One capability, nameable in a word — if the description needs "and", it's
   two bases or a blueprint.
2. Useful enabled alone.
3. A handful of collections max (floor ≈ `reactions`, ceiling ≈ `identity`).
4. Expressible in today's primitives (workflows, computed-unique keys, access
   rules, events, schedules, CAS) — no new engine.
5. Credential-free; no hosted code.

## Identity & access (4)

| Base | What it is | Status |
|---|---|---|
| `identity` | users, roles, permissions registry, invitations, auth trail (≈ auth_kit) | live |
| `teams` | orgs + memberships (one per user+org), split out of auth_kit | extract |
| `directory` | public member/vendor profiles + claim flow | new |
| `entitlements` | plan definitions + user grants for feature gating | future — BILL-1 |

## Communication (5)

| Base | What it is | Status |
|---|---|---|
| `notifications` | per-user feed, unread, prefs, announcements (≈ notification_kit) | live |
| `messaging` | threads + messages, owner-scoped (the Hatchly shape) | new |
| `comments` | threaded comments on any entry + moderation workflow | new |
| `email_templates` | template library/management over the shipped HTML engine | extract — EMAIL-1 |
| `audience` | mailing lists + consent flags (outbound contacts — distinct from inbound `lead_capture`) | new |

## Content & publishing (6)

| Base | What it is | Status |
|---|---|---|
| `publishing` | draft → published → archived workflow, tags, SEO pairing | new |
| `media_gallery` | albums + image arrays (requested twice in the field: Fatsoz, Stallion) | new |
| `faq_kb` | searchable help articles | new |
| `changelog` | releases + entries (every SaaS needs one) | new |
| `podcast` | episodes + audio assets + publish windows (head renders RSS) | new |
| `surveys` | custom forms/questionnaires + structured responses (form defs as entries) | new |

## Commerce (7)

| Base | What it is | Status |
|---|---|---|
| `catalog` | listable/sellable items w/ price + availability (store, menu, jobs) | new |
| `orders` | cart → checkout → fulfillment lifecycle over platform Stripe | extract |
| `inventory` | stock counts via CAS decrements + low-stock events | new |
| `promotions` | discount codes, validity windows, usage caps (CAS) | new |
| `invoicing` | quotes/invoices w/ line items + status workflow (no payment custody) | new |
| `reviews` | rating + review per target, moderated, aggregate recipes | new |
| `fundraising` | campaigns w/ goal + progress (sum aggregates) + donations via checkout | new |

## Scheduling & operations (7)

| Base | What it is | Status |
|---|---|---|
| `booking` | resources/slots + no-double-book computed key (extracted from the CRM) | extract |
| `events` | happenings w/ start/end + publish window (the venue shape) | new |
| `registrations` | RSVPs/sign-ups per target, one per user (capacity via DM-3 later) | new |
| `workboard` | generic work items w/ pipeline workflow (tickets, kanban, approvals) | new |
| `waitlist` | signups + position + invite workflow (our own intake, generalized) | extract |
| `time_tracking` | time entries per user/task + sum aggregates (agencies) | new |
| `shifts` | rota assignments, no-double-book per person+slot | new |

## Engagement & growth (6)

| Base | What it is | Status |
|---|---|---|
| `reactions` | likes/saves/bookmarks, typed, one per user+target | new |
| `follows` | follower graph, unique pair | new |
| `referrals` | uuid codes + attribution + reward hooks | new |
| `achievements` | badge definitions + awards, unique per user+badge | new |
| `ledger` | points/credits via CAS increments — **scope with tongs: not a wallet, no custody** | new |
| `feedback_wall` | client-facing feedback collection (FEED-2, mirror of ours) | extract |

## Learning (3) · Safety (1) · Advisors (1)

| Base | What it is | Status |
|---|---|---|
| `curriculum` | courses + lessons structure | new |
| `progress` | per-user completion tracking, unique per user+item | new |
| `quizzes` | questions + attempts + stored scores (scoring computed by agent/hook) | new |
| `moderation` | reports/flags on any target + review workflow (every UGC app) | new |
| `seo_advisor` | score/audit tools (≈ seo plugin) | live |

## Parked — blocked on a missing primitive, not imagination

| Idea | Blocking primitive |
|---|---|
| rentals / range-booking | range-overlap constraints (exclusion), beyond equality keys |
| geo & check-ins | geo field type + distance queries |
| analytics counters | high-volume write path (rate/caps misfit today) |
| e-signatures | compliance + crypto surface |
| gift cards / wallets | money custody — deliberately out |
| secrets vault | masked/write-only field type (SEC-1) |

## Blueprint examples (compositions, not new code)

- **Countryside CRM** = lead_capture + booking + identity + notifications + glue
- **Venue/restaurant** = catalog(menu) + events + media_gallery + lead_capture + publishing
- **Helpdesk** = identity + messaging + workboard + faq_kb + notifications
- **Marketplace-lite** = identity + directory + catalog + orders + reviews + messaging + moderation
- **Membership/community** = identity + teams + publishing + comments + notifications + moderation
- **LMS** = identity + curriculum + progress + quizzes + orders
- **Newsletter** = audience + publishing + email_templates
- **Job board** = catalog(listings) + `applications`-style workboard + identity + notifications
- **SaaS starter** = identity + notifications + changelog + feedback_wall + ledger

## Ties

- Composition core (`provides` / `requires` / `includes`, one-provider rule) —
  the enforcement that makes this catalog safe to grow. BACKLOG PLUG-2.
- Verbs (Path B, undecided): if declarative verbs ship, they attach to BASES —
  each base expands the vocabulary; blueprints inherit it.
