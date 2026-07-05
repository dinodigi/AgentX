# 01 · Ops & quality (grade D — highest leverage)

Purpose: make the platform provable and recoverable. Today all verification is
hand-driven curl; there is no export, no CI, no metering.

## Sub-features

- [ ] **Smoke suite** (M) — `npm run smoke`: scripted batteries for validation
      guards, privacy projection, identity gates (bundles a mock-issuer
      helper), events + delivery log, rate limits, token scopes. Exits non-zero
      on any failure. THE prerequisite for everything else.
- [ ] **Ephemeral test project** (S) — suite creates + destroys its own project
      so runs never touch real data.
- [ ] **Data export** (S) — `export_entries(collection, format: json|csv)` tool
      + download button in admin. The client's "can I get my data out?" answer.
- [ ] **Pre-commit gate** (S) — typecheck + smoke wired into a `verify` script;
      document the habit (no GitHub CI until there's a remote).
- [ ] **Backup story doc** (S) — Neon PITR + manifest + entries export = full
      recovery; write the runbook.
- [ ] **Serverless readiness** (M, deploy-gated) — event emits via after()/queue
      instead of void promises; pluggable rate-limit store interface.
- [ ] **Usage metering** (M, platform-gated) — per-project request/storage
      counts; the substrate for quotas and billing.

Done when: one command proves the system healthy, and a client's data can be
fully reconstructed from exports.
