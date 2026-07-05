# 10 · Connectors (grade B-)

Purpose: BYO infrastructure — the control-plane bet. Encrypted secrets, Clerk
+ Resend, health checks exist. Most of what remains is platform-phase work.

## Sub-features

- [ ] **Secret rotation UX** (S) — replace-in-place with old-value grace
      window; today rotation = retype and hope.
- [ ] **Dashboard health badges** (S) — connector status dots on the studio
      project cards; a dead issuer should be visible before a client hits it.
- [ ] **Scheduled health checks** (S, post-deploy) — cron the existing probe;
      flip status + surface failures in the delivery log.
- [ ] **OAuth connect flows** (M/L, platform-gated) — "Connect Clerk" as a
      button instead of paste-keys; matters when strangers onboard, not before.
- [ ] **Neon connector** (L, tenant-gated) — BYO database: connection mgmt,
      migration runner, data-plane routing. The bridge to Phase 6; build when
      a real tenant is standing at the door.
- [ ] **Provider expansion** (demand-gated) — Postmark/SES as Resend
      alternatives; Stripe-read for commerce sites. Each only on a real ask.

Done when: a project's external dependencies are visible, testable, rotatable,
and replaceable without touching code.
