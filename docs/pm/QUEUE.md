# The queue — every open item, dispositioned, in checkpoint order

> **Living — last synced 2026-07-28.** Protocol: [BURNDOWN.md](BURNDOWN.md).
> Regenerate counts with `npm run pm`; dispositions are judgments and are
> maintained by hand.

**Wall: 20 open** (32 − 6 closed 07-28 with receipts: A1×2, A2×2, A4×2 were
already shipped and still reading `new`).
**Backlog: 44 unshipped.**

⚑ = blocked on an operator decision. Everything else I drive.

---

## CP2 — Papercuts (Track B + the `ne` surprise) — SHIPPED 0dbf3ff

Six reports, all small, all in the same test surface — one gate, one push.

| Item | Disposition | |
|---|---|---|
| `d128f35a` B1 — `bulk_create_entries` vs `create_entry` shape asymmetry | 🔨 SHIP | accept both shapes; fix error ordering (leads with a downstream symptom) |
| `ad690ade` B2 — typed-block sub-fields reject explicit `null` | 🔨 SHIP | treat null as absent for optional relation/asset sub-fields |
| `4fae3449` B3 — `query_entries` rejects `id` in where | 🔨 SHIP | |
| `5e8146d8` B4 — MCP errors use delivery-facing wording | 📝 ANSWER | |
| `1a24b96b` B5 — `increment` refuses an unset field | 🔨 SHIP | the seed-or-fallback workaround **silently loses the first count** — needs atomic upsert |
| `4847bc14` — `ne` never matches unset fields | 📝 ANSWER | reporter says it's *correct but surprising*; that is a docs defect, not a behavior one |

## CP3 — The two bugs (reproduce first)

CLAUDE.md rule, and it has caught us four times: a live repro decides, never the
report's narrative.

| Item | Disposition | |
|---|---|---|
| `58aaca1e` E1 — `briefing.health` says `error` on working connectors | 🔨 SHIP | partially verified: all four rows read `connected` in the control DB, so the briefing computes status differently or serves stale |
| `921f9ec7` E2 — `get_client_code` omits `update()`/`remove()` for claim-write | 🔨 SHIP | either the generator or the docs is wrong — find out which **before** changing either |

## CP4 — `indexed` on date fields (A3, 2 reporters)

`0a5ce08c` + `34acd74d`. 🔨 SHIP — expression index over the normalized instant.
Both reporters said the error message is good but the suggested workaround has no
substitute: `published_at` is *the* sort key for content, `starts_at`/`ends_at`
*the* filter for scheduling. If the index turns out to be infeasible, this
becomes 📝 ANSWER — state the limit plainly and say why.

## CP5 — Anonymous intake + gated writes (A5, 2 reporters)

`e0b6eb32` + `16d745d3`. 🔨 SHIP — **decision made: they compose.** Any non-`none`
`access.write` currently *replaces* the anonymous POST path, forcing a
two-collection split for public form in / staff triage desk — the single most
common shape on the platform. `publicWrite` will govern anonymous POST;
`access.write` will govern PATCH/DELETE. Not an operator call: the current
behavior has no defender and the composed reading is what the docs already imply.

## CP6 — Schema mutation ergonomics

| Item | Disposition | |
|---|---|---|
| `9c2333cb` — no additive field op (re-send every field to add one) | 🔨 SHIP | lost-update hazard, not just typing |
| `73a14ef7` — enum option renames have no mapped migration | 🔨 SHIP | `renames:[]` covers fields only, so an option rename silently orphans rows |
| `1c10d760` — 100 rows/call makes real migrations chatty | 🔨 SHIP | 3.1k-lead import = 31 calls; raise the cap or document the ceiling honestly |

## CP7 — Scaling traps (Track C)

| Item | Disposition | |
|---|---|---|
| `cbf4db8f` C1 — array fields cannot be filtered on delivery | 🔨 SHIP | **worst failure profile on the board**: ships fine at 5 rows, wrong at 500, and the generated client's filter type advertises `tags` — implying it works |
| `a1fb8001` C2 — `publicFilter` cannot express relative time | 🔨 SHIP | `define_schedule` already accepts a `{daysAgo}` vocabulary — the language exists, it just isn't wired here |
| `2684fec0` C3 — no date bucketing / second `groupBy` | 🔨 SHIP | long-standing, the by-month report pipeline |

## CP8 — Capacity + reach

| Item | Disposition | |
|---|---|---|
| `8570cb24` — no counting/capacity constraint (`max N rows per key`) | 🔨 SHIP | booking capacity; `unique` gives exactly-one, nothing gives at-most-N |
| `de626cb6` — no SMS connector | ⏳ TRIGGER ⚑ | needs an operator account + a paying reason. **Trigger: a second project asks, or one client commits to SMS.** |
| `42a6d515` — `countryside_crm` ships `tools:[]` | ⏳ TRIGGER | plugin-authored tools are a design pass of their own (PLUG line). **Trigger: after the wall is clear.** |

## CP9 — The decision round ⚑

These three need you, and they're worth one sitting together rather than three
interruptions. I'll bring options and a recommendation for each.

| Item | Why it's yours |
|---|---|
| `0ceec805` D1 — `auth_kit` leaves credentials to every tenant | **Strategic, not technical.** Store credential material (breaking "credential-free by design"), ship a verified reference implementation, or stay out and document the trap loudly? All three are defensible. The current position is the only one that is *silently* dangerous — the reporter had to know to use a real dummy hash so response latency doesn't enumerate accounts, and said they'd expect most integrators to miss it.<br><br>**Operator note 07-28:** the reporter storing argon2id hashes in a tenant collection proves the constraint was never technical — the platform holds credential material fine today. "Credential-free" is positioning, not a capability limit. So the question is not *can we*, it is **whether we make the correct implementation the default one**. Storing the hash is the easy 10%; the 90% is dummy-hash timing, lockout, single-use non-enumerating reset tokens, session invalidation on password change, and migrating argon2id params as hardware improves. Two counterweights for the decision: (a) holding credentials changes our BREACH PROFILE — a leak stops being content and starts being auth material for every tenant's end users, and the blast radius lands on us whoever wrote the code; (b) there is a cheaper 80% — platform primitives that make the traps hard to hit, chief among them the **write-only field type already in the backlog** (never returned by any read, MCP or delivery) plus a verified reference `auth_kit` v2. |
| `eff3e105` + `66d1cbd9` D3 — a browser-safe delivery credential | Two reporters, and a measured cost: **XVibe runs an edge proxy per app for the sole purpose of holding a token.** Touches CDN cache keys, rate limiting, and abuse surface. |
| `6809681c` D2 — workflow transitions gate on WHO, never on WHAT | "May not go live without a creative" becomes a required field, which then blocks saving a draft — the constraint lands at the wrong moment. Design shape is clear (`when` clauses exist elsewhere); the call is whether it earns a slot now. |

## CP10 — The backlog sweep (44 unshipped)

Same four dispositions, applied to `docs/BACKLOG.md`. Expect most to land ⏳
TRIGGER or 🚫 DECLINE — a backlog that has never been dispositioned accumulates
ideas that were never actually committed to. Anything that survives as 🔨 SHIP
joins the queue above.

---

## Done means

`npm run pm` reports **0 open**, and every 🚫 / ⏳ has its reason or trigger
written into the wall reply where the reporter can read it.
