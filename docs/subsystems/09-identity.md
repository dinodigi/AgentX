# 09 · Identity — ungated items done 2026-07-05; rest needs the user

Purpose: end-user auth for client sites. BYO-issuer verification + three rule
presets + owner stamping exist — verified against a mock issuer only.

## Sub-features

- [ ] **Real-Clerk validation session** (S, needs user) — connect an actual
      Clerk instance, run the Alice/Bob battery live. Until then Phase 4 is
      mechanically proven but not field-proven.
- [ ] **Claims-based role presets** (M, evidence-gated) — `{claim, in: [...]}`
      on read/write; roles without an expression language.
- [ ] **set_user_role tool** (S, after roles) — writes Clerk user metadata via
      the connector's secret key.
- [x] **Verification options** (S) — ✅ audience check (connector `audience`),
      30s clock tolerance, multiple accepted issuers (`additionalIssuers`,
      routed by the token's own iss; forged iss just picks the rejecting JWKS).
- [x] **Session guidance doc** (S) — ✅ docs/runbooks/session-guidance.md
      (JWT-only revocation caveat, TTL = revocation latency, aud guidance).

Done when: a real client app's users sign in, see only their own data, and
role-gated writes work — all configured by an agent through the connector.
