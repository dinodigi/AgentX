# 10 · Connectors — ungated items done 2026-07-05; rest is platform-phase

Purpose: BYO infrastructure — the control-plane bet. Encrypted secrets, Clerk
+ Resend, health checks exist. Most of what remains is platform-phase work.

## Sub-features

- [x] **Secret rotation UX** (S) — ✅ rotate-with-validation: the candidate
      key is probed against the live provider BEFORE the old key is replaced
      (Rotate-key flow in the connector card). Old key kept on any failure.
- [x] **Dashboard health badges** (S) — ✅ connector status dots on the studio
      project cards; a dead issuer is visible before a client hits it.
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
