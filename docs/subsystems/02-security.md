# 02 · Security (grade B)

Purpose: the trust floor. Scoped tokens, rotation+TTL, encrypted secrets, and
access shielding exist; what's missing is verifiability and abuse hardening.

## Sub-features

- [x] **Webhook HMAC signatures** (S) — ✅ 2026-07-05: `t=<unix>,v1=<hex>` over
      `${t}.${body}`, per-project secret, reveal in settings, verify note in API ref.
- [x] **CORS policy on /v1** (S) — ✅ 2026-07-05: permissive (bearer-only auth, no
      CSRF surface), OPTIONS + headers on all delivery responses.
- [x] **Upload hard limits** (S) — ✅ 2026-07-05: 10 MB + type allowlist at the
      uploadAsset choke point (covers admin + MCP).
- [x] **Light audit log** (M) — ✅ 2026-07-05: audit_log table, actor threaded
      through all three surfaces (mcp/admin/delivery), write-only; UI in 07.
- [x] **Security headers pass** (S) — ✅ 2026-07-05: frame/content-type/referrer
      headers via next.config; strict CSP still deferred (Clerk allowlist work).
- [x] **Token last-used tracking** (S) — ✅ 2026-07-05: stamped on cache miss
      (≤5-min granularity), shown in settings token list.
- [ ] **Content-scope token** (M, gated on custom-admin demand) — entry CRUD
      without schema ops; the right credential for agent-built dashboards.

Done when: a security-minded client's checklist (signatures, CORS, audit,
limits) gets all yeses.
