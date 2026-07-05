# 09 · Identity (grade B)

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
- [ ] **Verification options** (S) — audience check, clock-skew tolerance,
      multiple accepted issuers per project (staging + prod Clerk).
- [ ] **Session guidance doc** (S) — JWT-only means no server-side logout;
      document short-TTL guidance for sensitive collections.

Done when: a real client app's users sign in, see only their own data, and
role-gated writes work — all configured by an agent through the connector.
