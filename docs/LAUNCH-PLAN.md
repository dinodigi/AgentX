# Launch Plan — from feature-complete platform to public product

*Drafted 2026-07-10, greenfield edition: the shared DB has been wiped by the
operator; every project on the platform was a test project. No data migration,
no dual-write transition, no legacy shared-tables mode — the new data plane is
the only data plane.*

**Launch =** a stranger can sign up, get a free workspace, pay for a project,
choose **BYO keys** or **managed infra**, and build on it with an agent —
while we watch every tenant from an operator console.

## The model (decided 2026-07-10)

- **Free workspace, pay per project.** The paywall is also the abuse gate.
- **Per project, two paths, one mechanism:** BYO (their Neon/R2/Clerk/Resend/
  Stripe keys) or managed (we provision from our Neon org + R2 via the same
  connector slots — managed = us being the key-holder).
- **Everything isolated per project.** No workspace-level shared keys (explicitly
  rejected). Every project gets its own database from day one; the shared DB
  shrinks to pure control plane.
- **Dev + prod environments per project** — the current dev/prod mixing problem
  is a launch-scope fix, not a later polish.
- **Caps, not metering.** Flat price + included allowances + hard caps with
  upgrade prompts. Invoice-grade usage billing is explicitly out of scope.
- **Out of scope for launch:** Phase 14 (semantic search), plugins, enterprise
  cross-app communication, per-row ACL, overage billing.
- **Recorded north star (not scoped):** enterprise workspaces — teams join a
  workspace (domain-locked invites, SSO later), and its projects can opt-in
  communicate via explicit bridges. B1's role hierarchy is built so this stays
  a cheap extension, not a rework.

### Post-launch backlog (recorded, build after the launch plan)

- **Beta-tester feedback widget** — an in-admin "send feedback" control for beta
  testers; submissions come back to the operator. Naturally dogfoodable: a
  publicWrite `feedback` collection on an AgentX project, exactly like the
  marketing `signups` intake (0.2). Small.
- **Beta self-serve gate** — an "approved beta tester" flag that reopens
  `createProject` for that user (front half of B2, minus billing). Buildable
  before B3; turns manual concierge onboarding into self-serve.
- **Invite accept flow** — pending-invitation step before a workspace member is
  active (today membership is instant). Deferred from B1.

### Plugins / AI-extensible tools — three versions (recorded 2026-07-11, all post-launch, Phase 21)

The question: can the agent's tool vocabulary grow beyond the ~42 built-ins?
Three tiers of "extend the toolbox", in ascending power *and* risk:

- **V0 — developer-published plugins (the baseline Phase 21).** A developer
  (us, later 3rd parties) publishes a package of tools (e.g. a Bookings plugin
  adding `check_availability`/`book_slot`); a project enables it; the agent can
  then call those verbs. The AI *calls* the tools, doesn't author them. Needs a
  registry + per-project enablement + MCP tool proxying.
- **V1 — AI-registered tools backed by a tenant endpoint (recommended future).**
  The agent itself registers a new tool on the fly, pointed at the tenant's own
  signed HTTP endpoint (natural extension of the hooks model). Self-extending
  agent, no human in the loop, and the "we never host tenant code" boundary
  stays intact (the code runs on the tenant's infra; we store the tool def +
  proxy the call). More powerful than V0; same safety envelope.
- **V2 — AI-authored code that WE host + execute.** Maximal power, but it breaks
  the core safety thesis and is a secure-code-execution product unto itself
  (sandboxing, attack surface). **Operator's framing (2026-07-11): a genuine
  possible future, but a DIFFERENT product within Pluggie — its own conversation,
  not this launch.** Explicitly rejected for the current platform.
- **Middle option (mostly buildable today):** AI composes a reusable *blueprint*
  (collections + workflows + events + hooks bundle) via the export/import
  manifest — reusability, not new power.

Decision deferred by the operator ("big feature, decide later"). None of this is
in the launch plan.

---

> **Progress note:** this file is the durable source of truth for launch
> progress — `[ ]` todo, `[~]` in progress / drafted, `[x]` shipped. Update it as
> items land.

## Step 0 — this week, before any track work

- [x] 0.1 (S) **Gate project creation to platform operators.** ✅ shipped
      2026-07-11 (commit 7ea1ee1, pushed). Server action + `/admin/new` page +
      all four New-project affordances gated on `getViewer().isPlatformOperator`.
- [x] 0.2 (S) **Real marketing intake — dogfooded on AgentX itself.** ✅ shipped
      2026-07-11 (commit cb0e084, pushed). "Pluggie Marketing" project + publicWrite
      `signups` collection; forms POST via a server action to our delivery API;
      verified end-to-end. ✅ `MARKETING_INTAKE_TOKEN` confirmed set in Render
      2026-07-11 — prod signups live.
- [x] 0.3 (S) **ROADMAP.md refresh** — ✅ shipped 2026-07-11 (commit feadecc,
      pushed). Render corrections, launch-plan supersession, plugins on hold.

## Track A — the data plane (Phase 19, reshaped for greenfield)

- [x] A0 (M) **Design doc** (`docs/gap-designs/design-data-plane.md`) — **✅
      approved 2026-07-11.** Operator confirmed all 6 open-question recommendations:
      (1) collections stay control-plane; (2) high-volume logs → tenant DB;
      (3) hand-written SQL migrations; (4) test/dev falls back to the control DB;
      (5) managed granularity — I research Neon facts before A3 (doesn't block A1);
      (6) accept the FK asymmetry (control DB keeps FKs, tenant DBs don't). A1
      proceeds on these. Original four questions the doc owns:
      1. **Table split** — what moves to the tenant DB (entries, trash, versions,
         entry_changes, assets…) vs stays control-plane (workspaces, members,
         project registry, tokens, connector refs, usage, audit) vs needs care
         (jobs, schedules, transact receipts, webhook logs — the coordination
         tables).
      2. **Resolver seam** — every content query resolves a per-project (and
         per-environment) connection; includes a local/dev backend so the smoke
         suite's ephemeral projects never provision real Neon.
      3. **Migration runner** — install + version the fixed table set in every
         tenant DB forever (greenfield removes backfill, not this).
      4. **Provisioning flows** — BYO (paste connection string → validate →
         install → route) vs managed (Neon API against our org), and how
         environments map onto each.
- [x] A1 (L) **Resolver + migration runner + local backend — ✅ COMPLETE
      2026-07-11.** Everything behavior-preserving (no project has a neon
      connector yet → every call resolves to the control DB); full smoke
      404/404 through the fallback proves the seam without real Neon.
      - [x] A1.1 (a72fb60) — `lib/data-plane.ts` resolver: `tenantDb`/
        `withTenantTransaction`, fail-closed control-DB fallback, client cache.
      - [x] A1.2 threading — all 4 batches:
        - [x] write path (65a8a5d): verifyRefs join decomposed, 4 cores,
          transact + replay → tenantDb. Smoke 53/53.
        - [x] derived-writes + index-sync (60fd41a): record{Change,Version,Audit}
          + feed/version/audit reads + prunes; syncUnique/SearchIndex(projectId)
          on tenantDb. Smoke 20/20.
        - [x] read paths (a4e8927): entries query/get/count/aggregate + resolve/
          expand/reverse readers, restore-version, bulk insert, search, locales,
          trash (listTrash's collections-name subquery decomposed cross-plane),
          assets/r2, export, delayed-event re-read, checkout. Full smoke 404/404.
        - [x] schema-change scans + logs + admin (076f4d7): define_collection
          diff-plan scans, rename/localized-toggle backfills, delete-collection
          chunker + an EXPLICIT tenant-side sweep of entries/trash/versions
          (tenant DBs have no FK into control-plane `collections`, so the
          control DB's cascade cannot exist there); webhook_deliveries call
          sites (webhook/hooks/events/settings); per-project admin surfaces.
          Targeted smoke 88/88.
      - [x] A1.3 (0469ab9) — `env` on project_tokens (NOT NULL DEFAULT 'prod',
        applied to the live DB by hand), TokenInfo carries it, token cache key
        bumped v3. All-prod until A5 mints dev tokens.
      - [x] A1.4 (994d0da) — `lib/tenant-migrations.ts`: versioned runner
        (advisory-locked, per-step atomic commit with `_schema_migrations`,
        Neon `-pooler` → direct-endpoint normalization) + v1 DDL (8 tables, no
        FKs) + the 5-rule expand/contract contract. Exercised end-to-end
        against a real throwaway PG18 database on our Neon instance: fresh
        apply 0→1, idempotent re-run, probe, entries round-trip, partial
        idempotency index enforced.
- [x] A2 (M) **Neon connector, BYO mode — ✅ COMPLETE 2026-07-11.** Connect →
      validate (session probe: PG15+, CREATE privilege) → install
      (migrateTenantDb) → store encrypted → route → replay per-collection
      indexes. `lib/neon-connector.ts` is the ONLY storing path (the generic
      form action's type excludes neon), with a zero-content guard (content
      migration stays out of scope; same-string reconnect = allowed heal) and
      a BYO-invariant disconnect (their DB is never touched). Dedicated admin
      card. **Acceptance proof — smoke 49 against a REAL second database:**
      first content op passes the migrate gate and installs v1; entries,
      versions, changes, audit, trash, assets, and partial indexes all live
      tenant-side; control DB holds zero content; fallback sibling has no
      cross-talk; public image URL resolves via the pointer. Full suite
      409/409. Gate list resolution:
      - [x] Migrate-before-first-use gate + quarantine (70564bd) — tenantDb/
        withTenantTransaction verify once per process per conn string; failure
        flips the connector to error and fails closed.
      - [x] Keyed envelopes (1ce4cdd) — v2.<kid> ciphertexts, keyring env,
        legacy k0 compat, rotation runbook in lib/crypto.ts.
      - [x] Dashboard/console counts (ce6de1f) — tenantContentStats fan-out
        overlay, bounded to connector-backed projects; zeros + error chip when
        unreachable. B3 rollups replace at scale.
      - [x] Image route (ce6de1f) — control-plane `asset_pointers` written on
        upload; bare-uuid URLs unchanged.
      - [x] `-pooler` handling — resolved by design: the runner self-normalizes
        to the direct endpoint (session advisory locks); stored strings may be
        pooled (neon-http + interactive transactions are pooler-safe).
      - [x] Index replay on provision (70564bd) — replayCollectionIndexes.
      - [ ] (Non-blocking, A3-or-later) resolver-lookup cache: tenantDb still
        resolves the connector row per call (~1 extra control query per
        content op); add short-TTL cache + eviction on connector change.
- [x] A3 (M) **Managed provisioning — ✅ COMPLETE 2026-07-11 (81c3628).**
      Decision (design doc §13.5, live-docs verified): **one Neon project per
      tenant project** in our org — Scale plan 1k projects soft-cap, no
      per-project minimum, scale-to-zero ≈ storage-only idle cost, A5 dev env
      = a branch in the tenant's own Neon project, 7-day delete recovery.
      `lib/neon-api.ts` (+ NEON_API_BASE mock override) +
      `provisionManagedDatabase`: zero-content guard → create → **teardown
      handle stored first** → ready-poll → schema install → conn stored →
      index replay; mid-failure quarantines with the handle and retry
      tears down the orphan + provisions fresh; a row with a stored secret is
      never replaced. Deprovision is loud + confirm-gated; **project delete
      (B2) now tears down managed DBs instead of refusing**. Proof:
      `scripts/exercise-managed-provisioning.ts` (committed, on-demand) — mock
      control API over REAL created/dropped databases, 5/5; smoke 49
      regression 6/6. **✅ REAL-API RUN PASSED 2026-07-11** (operator's
      NEON_API_KEY in Render + local .env): actual Neon project provisioned,
      schema v1 through the gate, content routed in (control DB zero rows),
      torn down. Auto-provision-on-create wires into B2's setup state.
- [x] A4 (M) **R2 as a connector — ✅ COMPLETE 2026-07-11 (92f282b + 32943bd).**
      `storageFor(projectId)` resolves the storage plane exactly like tenantDb
      (shared env fallback; fail-closed on malformed rows); uploads, deletes,
      image-transform derivatives + their 302s, and B2 byte-cleanup all ride
      it (cleanup is mode-aware: shared prefix-delete / BYO never touched /
      managed goes with the bucket). BYO connect = full-loop probe (write with
      their keys → read back through THEIR public URL → delete) + zero-asset
      guard; managed = real S3 CreateBucket in our account (**platform token
      verified account-scoped — no new secret for the bucket lifecycle**),
      handle-first + resumable, r2.dev public URL via the Cloudflare REST
      managed-domain endpoint (r2.dev rate limits accepted for launch;
      per-tenant custom domains post-launch). Proofs: BYO exercise 7/7 vs the
      real bucket, managed exercise (committed, on-demand) 4/4 with a REAL
      bucket lifecycle, smoke 50 server-path 3/3 + regressions.
      **✅ REAL-API RUN PASSED 2026-07-11** (operator's CF_API_TOKEN): actual
      bucket + live r2.dev public URL, upload served byte-exact over the
      public internet, torn down — managed infra fully operational.
- [ ] A5 (L) **Dev/prod environments.** Managed: dev = Neon branch of prod,
      promote = schema-diff apply (engine exists). BYO shape to be settled in A0
      (two connection strings vs a granted Neon API key). Per-env MCP tokens +
      delivery endpoints; environment switcher in the admin shell.

## Track B — the business layer (Phase 20, reshaped)

- [x] B1 (M) **Workspaces — ✅ shipped 2026-07-11.** Sign-up → workspace;
      workspace owns projects; members ride the existing project_members shape.
      ADMIN_EMAILS is now a real platform-operator role.
      - [x] **B1a (c45f8b1):** schema (`workspaces`, `workspace_members`,
        `projects.workspace_id`), the 3-rung access ladder in `lib/access.ts`,
        `createProject` → personal workspace, dashboard "Your projects / Shared
        with you". Migration applied to the shared DB (4 workspaces, 17 projects
        backfilled); ladder verified against real data; smoke 11/11.
      - [x] **B1b (2606fa4):** `/admin/workspace` team management — owner/admin
        add/remove members (admin|manager) + rename, gated; "Team" nav link.
      - [x] **B1c (cdbcd3f):** workspace **switcher** — active-workspace context
        (cookie-backed, validated), dashboard scoped to one workspace at a time
        (replaces the Your/Shared grouping), switcher on the dashboard / project
        switcher inside a project. Verified incl. forged-cookie isolation.
      - **Deferred:** invite **accept** flow (membership is instant today; a
        pending-invite step is a follow-up — circle back). Invitee still must
        have a Clerk account.
      - Decided 2026-07-10:
      - Workspace roles (owner / admin / manager) **cascade** to all workspace
        projects; per-project member rows remain the bottom rung for sharing a
        single project with an outsider (the client-handoff path).
      - Access resolution ladder: platform operator → workspace role →
        project member row. Dashboard = the union of everything reachable,
        grouped **"Your projects" / "Shared with you"** in the fleet + switcher.
      - **Ownership is singular:** a project belongs to exactly one paying
        workspace. Sharing spreads access, never billing, keys, or deletion.
- [~] B2 (M) **Project lifecycle.** Create → *setup* state (choose BYO or
      managed, connect or provision) → active → **deleted**. Self-serve creation
      reopens here, behind a plan. MCP token + delivery API light up only on
      active.
      - [x] **Deletion — ✅ shipped 2026-07-11 (6bac047).** Danger zone on
        project Settings: plan (counts) + type-the-name confirm, gated to the
        owning workspace's owner/admin (a share can't delete), best-effort R2
        prefix cleanup + cascade delete. Refuses if a managed `neon` connector
        exists (data-plane teardown = A3). Caught + worked around a live-DB bug:
        4 tables lack their `project_id` FK cascade (see [[missing-fk-cascades]]),
        so the action deletes them explicitly. Spawned a task to repair the FKs.
      - [ ] **Setup state** (choose BYO/managed, provision) — needs Track A.
      - Decided 2026-07-10 — users can delete their own projects:
      - Destructive = **plan + confirm** (design rule): the delete plan discloses
        what goes (collections, entries, assets, tokens, connectors) and requires
        an explicit confirm (type-the-name gate).
      - **Managed** projects deprovision their infra on delete — tear down the
        project's Neon database/branch and R2 bucket so we stop paying for
        orphaned resources (ties to Track A's provisioning). **BYO** projects
        drop our control-plane records and stop routing but NEVER delete the
        tenant's own database/bucket — it's theirs.
      - Delete **stops the per-project subscription** (coordinate with B3) and
        removes the project from every member's dashboard.
      - Gated to the owning workspace's owner/admin — a shared manager can work
        in a project but cannot delete it (B1: sharing never spreads deletion).
      - Consider a soft-delete grace window (restore-able for N days) before the
        managed-infra teardown actually fires, mirroring entry trash.
- [ ] B3 (L) **Billing + caps.** Our own Stripe (subscriptions per project —
      new work; Phase 15 was tenants' checkout). Usage counters (requests,
      storage, entries) → daily rollups → hard-cap enforcement with clear
      errors + upgrade prompts.
- [~] B4 (M) **Operator console — read view ✅ shipped 2026-07-11 (d8e00c3 +
      fe6a7f8).** `/admin/console` (operator-gated) shows all workspaces + all
      projects with scale + connector health, link into any project for support.
      And the everyday dashboard is now **personal even for operators** — the
      god view moved off `/admin` into the console (operators keep god-mode
      *access* via getProjectRole, only the listing is scoped). **Still todo:**
      usage/plan columns (need B3), a suspend control, and the support-access
      audit-log policy. Decided 2026-07-10:
      - The console is a **separate surface** (own route, operator-gated, reads
        the control plane). The everyday dashboard shows only our own workspace,
        like any tenant — fixing today's ADMIN_EMAILS behavior of mixing every
        tenant's projects into the operator's normal dashboard.
      - Platform-account data (who signed up, projects per workspace, cap usage)
        lives HERE — never in the dogfooded marketing project, which only holds
        content-shaped data (waitlist leads via its publicWrite inbox).
      - Policy to settle during B4: whether operators can enter a tenant's
        project admin at all (support access), and under what audit logging.

## Track C — launch readiness

- [ ] C1 **★ Dogfood milestone** (after A3): rebuild a real Currents site as
      tenant #1 on the new data plane. The friction log is the launch
      go/no-go input. Needs the operator's involvement.
- [ ] C2 (M) **Durable rate-limit store** (long-standing infra item — matters
      the moment strangers arrive).
- [ ] C3 (S) **Pricing page goes real** — numbers from the operator; marketing
      copy shifts from "private beta" to launch.
- [ ] C4 (M) **Security pass** — control-plane isolation audit (what little
      stays shared), token hygiene (old 2.5), secret rotation, `createProject`
      hardening review.
- [ ] C5 (M) **Ops** — backups/PITR on control plane + managed org, Render
      monitoring/alerts, error tracking.
- [ ] C6 **Legal basics** — ToS, privacy. Operator's court; flagged early.
- [ ] C7 **Launch checklist** — full smoke vs prod, restore drill, load sanity.

## Sequencing

```
0.1  0.2  0.3            ── immediately
A0 → A1 → A2 → A3 → A4 → A5
            ↘ B1 → B2 → B3 → B4     (B1 can start once A2 proves the seam)
                 A3 → C1 (dogfood)
C2/C4/C5 slot into gaps; C3/C6 on the operator; C7 last.
Launch gate = A-track + B-track + C1 + C4 + C5 + C7 all green.
```

## Decisions needed from the operator (blocking marked ⚑)

1. ~~⚑ **Pricing anchors**~~ — **✅ DECIDED 2026-07-11: $19/mo BYO, $29/mo
   managed, per project (= per application), workspace free.** Unblocks B3
   (subscriptions + caps sized against these anchors) and C3 (pricing page
   gets real numbers; the private-beta→launch copy shift stays a launch-time
   call).
2. ~~**Free sandbox project per workspace**~~ — **✅ DECIDED 2026-07-11: YES,
   one hard-capped sandbox per workspace** (shared plane only, dev-grade caps
   — e.g. ~1k entries / 100MB media, exact caps set in B3); upgrading to a
   paid project unlocks the real per-project data plane. Shapes B2's setup
   state + B3's plan gating.
3. **Name + domain** — **pluggie.app acquired** (2026-07-11); name effectively
   settled. Remaining: Clerk **production instance** on pluggie.app (DNS + prod
   keys) before flipping off the Render URL — see the domain runbook in chat.
4. **BYO environments shape** — two connection strings vs granted Neon API key
   (settled in A0 review).
5. **Legal entity + ToS/privacy path** (blocks C6).
6. **Operator support access** — may platform operators open a tenant's project
   admin, and with what logging? (settled during B4; default leaning: allowed
   but audit-logged and visible to the tenant).

## Honest sizing

The gap-closing track shipped ~40 increments in four days of sessions, but A1
and A5 are architectural (the resolver touches every content query; environments
touch tokens, delivery, admin). Realistic shape: **Step 0 in one session; A0+A1
across a few sessions; the rest of Track A a session or two each; Track B
similar.** The long pole is A1 — everything else is the platform's usual
increment size.
