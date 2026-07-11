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

---

## Step 0 — this week, before any track work

- [ ] 0.1 (S) **Gate project creation to platform operators.** `createProject`
      currently only checks signed-in; sign-up is open. One authz check + hide
      the "New project" affordance for non-operators. Reopened self-serve at B2,
      behind billing.
- [ ] 0.2 (S) **Real marketing intake — dogfooded on AgentX itself.** The
      waitlist/beta forms are local-state dead ends. Create an AgentX project
      with a publicWrite `signups` collection; the marketing forms POST to its
      delivery API. First real dogfood, and signups stop falling on the floor.
- [ ] 0.3 (S) **ROADMAP.md refresh** — Netlify→Render corrections, mark this
      plan as superseding the Phase 19/20 ordering, note plugins on hold.

## Track A — the data plane (Phase 19, reshaped for greenfield)

- [ ] A0 (M) **Design doc** (`docs/gap-designs/design-data-plane.md`), reviewed
      together before code. Owns the four open questions:
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
- [ ] A1 (L) **Resolver + migration runner + local backend.** The single biggest
      lift of the whole plan; everything else stacks on it.
- [ ] A2 (M) **Neon connector, BYO mode.**
- [ ] A3 (M) **Managed provisioning** — Neon API, our org, auto-provision on
      project create.
- [ ] A4 (M) **R2 as a connector** — BYO bucket + managed per-project bucket;
      media + image-transform derivatives ride the same resolver.
- [ ] A5 (L) **Dev/prod environments.** Managed: dev = Neon branch of prod,
      promote = schema-diff apply (engine exists). BYO shape to be settled in A0
      (two connection strings vs a granted Neon API key). Per-env MCP tokens +
      delivery endpoints; environment switcher in the admin shell.

## Track B — the business layer (Phase 20, reshaped)

- [ ] B1 (M) **Workspaces.** Sign-up → workspace; workspace owns projects;
      members ride the existing project_members shape. ADMIN_EMAILS becomes a
      real platform-operator role. Decided 2026-07-10:
      - Workspace roles (owner / admin / manager) **cascade** to all workspace
        projects; per-project member rows remain the bottom rung for sharing a
        single project with an outsider (the client-handoff path).
      - Access resolution ladder: platform operator → workspace role →
        project member row. Dashboard = the union of everything reachable,
        grouped **"Your projects" / "Shared with you"** in the fleet + switcher.
      - **Ownership is singular:** a project belongs to exactly one paying
        workspace. Sharing spreads access, never billing, keys, or deletion.
- [ ] B2 (M) **Project lifecycle.** Create → *setup* state (choose BYO or
      managed, connect or provision) → active. Self-serve creation reopens here,
      behind a plan. MCP token + delivery API light up only on active.
- [ ] B3 (L) **Billing + caps.** Our own Stripe (subscriptions per project —
      new work; Phase 15 was tenants' checkout). Usage counters (requests,
      storage, entries) → daily rollups → hard-cap enforcement with clear
      errors + upgrade prompts.
- [ ] B4 (M) **Operator console.** All workspaces/projects, usage numbers,
      connector health, plan status, suspend switch. Decided 2026-07-10:
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

1. ⚑ **Pricing anchors** — per-project price for BYO vs managed (blocks B3, C3).
2. **Free sandbox project per workspace** — yes/no (shapes B2/B3).
3. ⚑ **Name + domain** — "Pluggie" is a working name, not settled (blocks C3,
   legal, and the Clerk/email/domain setup).
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
