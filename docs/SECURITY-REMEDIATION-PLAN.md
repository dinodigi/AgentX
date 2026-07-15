# Security Remediation Plan — HAv1 Scorecard

**Source:** `C:\dev\Tests\Security\HAv1\agentx-scorecard.html` (authorized self-assessment, 2026-07-15, target `pluggie.app`).
**Status:** Batch 1 SHIPPED & verified (2026-07-15) — see "Batch 1" below. Batches 2–3 still planned.
**Grade at assessment:** C / 75. Data-isolation core held; held out of a B by F2 + F3, plus a separate availability launch-blocker.

Every finding below has been confirmed against the actual code (file + line). The recurring good news: the fixes are small, and in most cases **the correct pattern already exists elsewhere in this repo** — we're extending it, not inventing it.

No database migrations are required for any Batch 1 or Batch 2 item **except** the F2 opt-in flag (Option C), which adds one optional field property (type-only, no column change). This matters given `db:push` is broken against Neon PG18 — see the [prod-deploy notes](#deploy--verification-notes).

---

## Priority summary

| # | ID | Title | Sev | Reachable by untrusted? | Batch |
|---|----|-------|-----|--------------------------|-------|
| 1 | D3 | Oversized body → worker OOM | Blocker | ✅ public write | 1 |
| 2 | D4 | Filter-clause amplification → outage | Blocker | ⚠️ MCP / stored publicFilter | 1 |
| 3 | F2 | Public-write mass-assignment | High (7.1) | ✅ public write | 1 |
| 4 | — | Email-relay via `{{field}}` `to` | High (derived from F2) | ✅ public write | 1–2 |
| 5 | D1/D2 | No rate limiting on GET-list + MCP | Med | ✅ / ⚠️ | 2 |
| 6 | F1 | Redirect-based SSRF | Med (5.8) | control-plane | 2 |
| 7 | F6 | IPv4-mapped IPv6 not classified private | Low (2.3) | control-plane | 2 |
| 8 | F3 | Relation label leaks hidden rows | Med (5.3) | ✅ public read | 2 |
| 9 | F4 | LIKE-wildcard injection in `contains` | Low (2.7) | MCP-only today | 3 |
| 10 | F5 | Infra topology disclosure (`list_connectors`) | Low (2.7) | admin-only | 3 |
| — | — | Close untested surfaces | — | — | 3 |

---

## Batch 1 — Launch blockers (D3, D4, F2) — ✅ SHIPPED

Three small, independent, high-leverage changes. Clears the availability blocker and the top data-safety High. Shipped together and verified via `scripts/smoke/55-hardening.test.mjs` + a regression sweep. Files touched: new `lib/http.ts` (bounded read); `app/api/v1/[collection]/route.ts`, `.../[id]/route.ts`, `app/api/v1/checkout/route.ts`, `app/api/mcp/route.ts` (body caps); `lib/query.ts` + `lib/mcp/tools.ts` (clause caps); `lib/access-rules.ts` (F2 invariant); `lib/events.ts` (email recipient validation).

### D3 — Oversized body → worker OOM

**Root cause.** `req.json()` runs with no size cap on the public delivery writes:
- Create: `app/api/v1/[collection]/route.ts:326`
- Patch: `app/api/v1/[collection]/[id]/route.ts:169`
- (also `app/api/v1/checkout/route.ts:65`, `app/api/mcp/route.ts:86`)

`middleware.ts` is Clerk-only and its matcher (`middleware.ts:19`) explicitly **excludes** `api/v1`, `api/mcp`, `api/jobs` — so no edge cap runs. `next.config.ts` sets no body limit. A 35 MB body reaches `JSON.parse`, balloons 5–10×, and OOMs the shared Node process → all projects 502 until Render restarts.

**The fix already exists in-repo.** `readBounded()` in `app/api/stripe/webhook/[projectId]/route.ts:59-85` (cap `MAX_WEBHOOK_BYTES = 1<<20`) rejects on both honest `content-length` and streamed overflow. Its own comment: *"an unbounded `req.text()` would let anyone OOM the shared process."* `lib/hooks.ts:51-72` has the same pattern (`readCapped`) for outbound.

**Plan.**
1. Lift `readBounded` into a shared util (e.g. `lib/http.ts`) so webhook + delivery share one implementation.
2. Add `DELIVERY_MAX_BODY_BYTES` (proposed default **1 MiB**; size to real payloads — richtext entries are the largest legit case). Apply to the create/patch/checkout/mcp `req.json()` calls, returning `413` on overflow.
3. Sketch:
   ```ts
   // replaces: const body = await req.json();
   const raw = await readBounded(req, DELIVERY_MAX_BODY_BYTES); // throws BodyTooLarge
   const body = JSON.parse(raw);
   ```
4. Defense-in-depth (optional, DevOps): a hard edge/`content-length` reject far below the current 50 MB, and a per-request timeout.

**Tests.**
- 1 MiB + 1 byte body → `413`, process stays up (no restart in Render logs).
- Legit max-size richtext entry → `201`.
- `content-length` header lying small but stream large → still rejected mid-stream.

**Risk:** low. Cap must be ≥ the largest legitimate entry payload — audit existing dogfood entries before picking the number.

---

### D4 — Filter-clause amplification → full outage

**Root cause.** `where` / `anyOf` is the **only** array input without a `maxItems`. `buildWhereParts()` (`lib/query.ts:117-140`) maps over `where[]` with no length cap and, for `anyOf`, checks only `length === 0` (`:124`) before `sql.join(conds, ' OR ')` (`:135`). 150k clauses → ~7.7 MB SQL string → OOM → brief full outage.

Sibling arrays are all capped (`ops`≤25 `tools.ts:655`, `aggregates`≤10 `:810`, bulk `entries`≤100 `:841`) — this one was simply missed. Schema gaps:
- MCP JSON schema `WHERE_ITEM_JSON.anyOf` — `lib/mcp/tools.ts:103` (`minItems:1`, no `maxItems`)
- Zod mirror — `lib/mcp/tools.ts:1133-1136` (`.min(1)`, no `.max()`)
- Uncapped `where` inputs: `tools.ts:703/772/788/822` and `publicFilter` at `:217`.

**Plan.** Two layers, because `publicFilter` is stored server-side and re-run on every read (it never re-passes the input schema):
1. **Runtime backstop (the real fix)** in `buildWhereParts` / `buildWhere` (`lib/query.ts:117-149`): throw a `ValidationError` if `where.length > MAX_WHERE_ITEMS` or any `anyOf.length > MAX_ANYOF_ITEMS`. Proposed `MAX_WHERE_ITEMS = 100`, `MAX_ANYOF_ITEMS = 200` (tune to real query shapes). Covers delivery GET, MCP, and stored `publicFilter` in one place.
2. **Front-door schema caps** for a clean error early: add `maxItems` to `WHERE_ITEM_JSON.anyOf` and the top-level `where` arrays; add `.max()` to the zod mirror.
3. Also cap `where[]` on the public delivery GET (`route.ts:130-187`) — it's uncapped too, though today it only emits `eq`.

**Tests.**
- `anyOf` with 201 clauses via MCP → `400`/`ValidationError`, no OOM.
- `define_collection` with a 300-clause `publicFilter` → rejected at define time; and if one is already stored, a read against it returns an error rather than crashing.
- 100-clause query still succeeds.

**Risk:** low, provided caps are above real usage. Grep existing stored `publicFilter`s for current max length before setting the limit.

---

### F2 — Public-write mass-assignment (moderation bypass) — **High**

**Root cause.** `checkFieldWrites` (`lib/access-rules.ts:309-325`) is a **denylist keyed on `writableBy`**: `if (!f.writableBy || exempt.has(f.name) || !(f.name in payload)) continue;` (`:317`). A field marked `publicRead:false` but with **no `writableBy`** is never inspected → an anonymous submission can set it. Confirmed: `POST /v1/reviews {approved:true}` → `201`, served publicly.

The two protections that *do* hold work by server-side override *after* accepting the payload, not by gating unknown fields:
- Workflow initial-state: `applyWorkflowOnCreate` (`lib/workflow.ts:67-80`)
- Owner/org stamping: `stampIdentity` (`lib/access-rules.ts:274-293`) strips client-supplied owner/org on the anonymous branch.

There is **no per-field `publicWrite` concept today** — field write control is only `writableBy`; `publicWrite` is collection-level (`db/schema.ts:223`).

**Design decision (RESOLVED — shipped the Targeted model, not fail-closed).** The literal report fix — *"reject `publicRead:false` fields on public writes"* — and its opt-in variant (Option C) both **break the common case**: implementing them revealed that public-write collections with non-`publicRead` submitter fields (`inbox.email`, `leads.email`, `messages.body`, `orders.sku`, `rsvps`, …) are the *norm*, not the exception. Fail-closed would require annotating essentially every form field, forever, to close only a *low-severity* residual (junk written to a non-gate admin field). Not worth taxing the common case.

**What shipped — the publicFilter invariant (Targeted).** The demonstrated *High* — self-approval — works by writing the field the collection's `publicFilter` keys on (`approved`). So: **a field referenced by the collection's `publicFilter` is never anonymously writable** — full stop, no annotation, zero migration. This joins the two locks that already held on the anonymous path (workflow initial-state via `applyWorkflowOnCreate`; owner/org via `stampIdentity`). To lock any *other* field against public writes, operators use the existing `writableBy:"none"`.

Implemented in `checkFieldWrites` (`lib/access-rules.ts`): a new `publicFilterFields()` helper flattens the `publicFilter` (incl. `anyOf`) into a field-name set; on the anonymous branch (`user === null`) any payload field in that set is rejected. `publicRead:true` content fields (rating, body, name, email) are unaffected — public forms keep working. No `publicWrite` flag, no schema/type change, no config migration, no test changes.

**Residual (accepted):** a non-gate, non-`writableBy:"none"`, `publicRead:false` field on a public-write collection remains anonymously writable. Low severity (no privilege/visibility escalation); operators lock it with `writableBy:"none"` if needed. Revisit only if a real case demands fail-closed.

**Tests (shipped in `scripts/smoke/55-hardening.test.mjs`, all green).**
- Anonymous `POST /v1/reviews {rating, body}` → `201` (content fields writable).
- Anonymous `POST /v1/reviews {rating, body, approved:true}` → `403` naming `approved` (self-approval blocked).
- A submitted review stays behind the gate (not auto-published).
- Regression sweep: 04/09/22/54/20/13 + the touched suites (02/03/11/16/24/34/35/39/42) all pass unchanged.

---

### Email-relay hardening (rides with F2)

**Confirmed vector.** `sendEmailAction` (`lib/events.ts:176-194`) interpolates the recipient: `to: interpolate(action.to, entry)` (`:184`), and `interpolate` (`:169-174`) pulls `{{field}}` straight from `entry.data`. `from` is pinned to the verified domain (`connector.config.fromEmail`, `events.ts:223`) but **`to` and `subject` are attacker-influenceable** when the operator's template contains a `{{field}}` token bound to a writable field. There is **no recipient format check or domain allowlist** anywhere (`collections.ts:218-220` only checks non-empty + non-localized). Combined with F2, a public write turns the app's domain into an authenticated spam/phishing relay.

**Plan.** F2 (Option C) is the primary fix — it removes the attacker's control of the interpolated field. Add defense-in-depth:
1. Validate the *rendered* `to` at send time (`events.ts:184`) is a single, well-formed address; drop + log otherwise.
2. Optional: operator-configurable recipient allowlist, or restrict `to` interpolation to fields that are **not** publicly writable.

**Tests.** Configure `to:"{{email}}"` where `email` is public-writable → after F2, a public write can no longer set an off-domain recipient / the send is validated and refused.

---

## Batch 2 — Hardening (rate limiting, SSRF, F3)

### D1 / D2 — Rate-limit coverage

**Current state (`lib/ratelimit.ts`).** Durable fixed-window, `MAX_PER_WINDOW = 20`/60s, keyed `${projectId}:${ip}`, **fail-open** (`:44-47`), IP from spoofable `x-forwarded-for`. Applied to delivery POST (`route.ts:317`), GET **only when `?q` present** (`:243-249`), PATCH/DELETE, uploads. **Not** applied to the plain GET list or the **entire** MCP endpoint (`app/api/mcp/route.ts` — no limiter). So D4's clause-bomb has neither a clause cap (fixed in Batch 1) nor a rate limit in front of it.

**Plan.**
1. Apply the limiter to the plain delivery GET list and to the MCP endpoint (per-token dimension for MCP).
2. Add a per-token key dimension alongside `projectId:ip`.
3. Reconsider **fail-open**: keep fail-open for reads, but fail-closed (or a stricter static cap) for anonymous public writes.
4. Fix IP source: on Render behind Cloudflare, derive the client IP from the correct trusted header/position instead of raw `x-forwarded-for` leftmost.

**Tests.** 1,200 reads @100 concurrent → sees `429`s; MCP flood → throttled; spoofed `x-forwarded-for` doesn't reset the window.

---

### F1 + F6 — SSRF: redirect revalidation + IPv6 classifier

**Root cause.**
- The guard `webhookTargetRefusal` (`lib/net-guard.ts:67-86`) validates only the **first hop**. Both fetchers — `lib/webhook.ts:57-62` (async events) and `lib/hooks.ts:119-128` (sync hooks) — call `fetch()` with default redirect-following (undici follows up to 20) and **never re-consult the guard** on the `Location`. A public URL 302→`http://127.0.0.1:10000/` is followed. Also reached via `lib/job-handlers.ts:103`, `lib/events.ts:157/299`.
- F6: `ipIsPrivate` (`net-guard.ts:23-47`) only strips `::ffff:` in **dotted-quad** form (`:24`). In compressed-hex form `::ffff:a9fe:a9fe` (how `dns.lookup`/undici often normalize), it falls through and returns `false` → `::ffff:169.254.169.254` bypass.
- TOCTOU / no IP pinning is **documented as accepted residual risk** (`net-guard.ts:14-17`) — out of scope for this pass unless we take the undici-dispatcher route.

**Plan.**
1. **Shared hardened fetcher** (`lib/net-guard.ts` or new `lib/safe-fetch.ts`): `redirect:"manual"`, manual redirect loop (cap ~5 hops), re-run `webhookTargetRefusal` on every hop's resolved address. Replace the duplicated `fetch()` calls in `webhook.ts`, `hooks.ts`, and the job-handler path with it.
2. **Fix `ipIsPrivate`** to normalize all IPv4-mapped IPv6 forms (parse via `net.isIP` / expand, or match `::ffff:` hex) before the private-range check. Add F6's `::ffff:169.254.169.254` and the compressed-hex variant to tests.
3. Note the guard is **production-only** (`guardActive()`, `net-guard.ts:49-51`) — tests must set `NODE_ENV=production` (and not `ALLOW_PRIVATE_WEBHOOK_TARGETS=1`) to reproduce.
4. Keep `CRON_SECRET` long/rotated and restrict `/api/jobs/drain` to genuine loopback (the SSRF can hit it but can't forge the secret) — the report's reinforcing note.

**Tests.** Public URL 302→loopback → refused on both hook and webhook paths; each redirect hop re-validated; `::ffff:169.254.169.254` classified private.

---

### F3 — Relation label leaks `publicFilter`-hidden rows

**Root cause.** `resolveRelations` (`lib/entries.ts:2032-2092`) fetches label targets by id+project unconditionally (`:2052-2057`) and applies **only** the org gate (`:2077-2088`) — never the target collection's `publicFilter`. So a public review referencing an unpublished trip returns `trip:{id,label:"UNRELEASED Antarctica"}`. The **expand** path does it right for contrast: `expandRelations` (`:2159-2239`) filters through `matchesClauses(targetColl.fields, publicFilter, data)` at `:2206-2214`.

**Plan.** Mirror expand in `resolveRelations`: after fetching `targetRows` (`:2056`), for delivery (`mode !== "trusted"`) viewers, load the target collection (already done for org at `:2070`) and mask any target failing `matchesClauses(targetColl.fields, targetColl.publicFilter ?? [], data)` — render as redacted/`{id, label:id}` or null. Reuse `matchesClauses` (`lib/query.ts:288-298`).

**Tests.** Public read of an entry whose relation points to a `publicFilter`-hidden row → label redacted; trusted/MCP read → full label; expand path unchanged.

---

## Batch 3 — Low-severity + close the unknowns

- **F4** — Escape `%` and `_` before building the LIKE pattern for `contains` (`lib/query.ts`). MCP-only today; latent if `contains` ever hits untrusted input.
- **F5** — `list_connectors` returns Neon host / R2 account+bucket / CF account id. Return only what the caller needs; treat endpoints as sensitive. Admin-only, recon value.
- **Untested surfaces to probe** (from the coverage table):
  - Email interpolation vector — *now partially addressed by F2 + email hardening*; still worth an explicit test.
  - Cross-tenant A-reads-B — needs a **2nd owned project** to complete (currently PARTIAL; scope-tampering already holds).
  - JWT positive path — **needs a non-empty `audience`** configured, then test expiry/issuer/audience.
  - Workflow state machine (actor-gating, illegal transitions; note "admin includes client-role in v1").
  - `transact` atomicity / `$ref` rollback edges.
  - Asset upload: content-type spoofing, SVG/XSS, filename traversal (uploads buffer whole file before the 10 MB check — `lib/r2.ts:131` — worth revisiting under D3 too).
  - Computed fields / hook transform (template/slugify injection; ownership re-stamp claim).
  - Changes-feed gating on `/v1/changes`.

---

## Rollout & verification notes

**Deploy mechanics (from prod-deploy memory):**
- Push to `master` auto-deploys on Render. **Run `npm run build` before pushing** — `tsc` misses Next route-file export rules.
- **Never** run `next build` while the `:3100` dev server is running (shared `.next` → every request 500s until restart).
- `db:push` is broken vs Neon PG18 — but Batch 1/2 need **no** migrations (F2's `publicWrite` is a type-only field property, not a column).

**Suggested PR breakdown:**
1. PR-1 = Batch 1 (D3 + D4 + F2 + email `to` validation). Blockers + top High in one reviewable unit.
2. PR-2 = SSRF (F1+F6, shared fetcher) + F3 label filter.
3. PR-3 = rate-limit coverage.
4. PR-4 = F4/F5 + the untested-surface test additions.

**Pre-deploy audits:**
- Payload sizes of existing entries → confirm they clear the 1 MiB `MAX_DELIVERY_BODY_BYTES` (uploads use the separate 10 MiB path). Bump if a real richtext entry is larger.
- Stored `publicFilter` clause counts vs. `MAX_ANYOF_ITEMS` (200) / `MAX_WHERE_ITEMS` (100) — confirm no legit query/filter exceeds them.
- F2 needs **no** config migration (Targeted model). Sanity-check: any public-write collection where a submitter is *meant* to set a `publicFilter`-referenced field would now 403 — none found in the suite; verify none in dogfood configs.

**Verification per finding:** each item lists concrete tests above; reproduce against a pre-production instance (SSRF guard needs `NODE_ENV=production`). Re-run the HAv1 suite after each batch to confirm the grade moves and nothing regressed.
