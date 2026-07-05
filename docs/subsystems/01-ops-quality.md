# 01 · Ops & quality (grade D — highest leverage)

Purpose: make the platform provable and recoverable. Today all verification is
hand-driven curl; there is no export, no CI, no metering.

## Sub-features

- [x] **Smoke suite** (M) — ✅ 2026-07-05: 8 files, 38 tests, `npm run smoke`;
      regression-catching proven by sabotage test.
- [x] **Ephemeral test project** (S) — ✅ per-file project, cascade destroy.
- [x] **Data export** (S) — ✅ export_entries tool (json/csv, 5k cap) + admin
      CSV/JSON buttons + covered in suite.
- [x] **Pre-commit gate** (S) — ✅ `npm run verify` + README habit note.
- [x] **Backup story doc** (S) — ✅ docs/runbooks/backup-restore.md (documents
      the id-remapping limitation → future import-with-ids item).
- [ ] **Serverless readiness** (M, deploy-gated) — event emits via after()/queue
      instead of void promises; pluggable rate-limit store interface.
- [ ] **Usage metering** (M, platform-gated) — per-project request/storage
      counts; the substrate for quotas and billing.

Done when: one command proves the system healthy, and a client's data can be
fully reconstructed from exports.
