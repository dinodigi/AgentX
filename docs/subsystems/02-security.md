# 02 · Security (grade B)

Purpose: the trust floor. Scoped tokens, rotation+TTL, encrypted secrets, and
access shielding exist; what's missing is verifiability and abuse hardening.

## Sub-features

- [ ] **Webhook HMAC signatures** (S) — `X-AgentX-Signature: sha256=…` over the
      body with a per-project signing secret; verification snippet in API docs.
- [ ] **CORS policy on /v1** (S) — permissive GET first, correct preflight;
      per-project origin allowlist later.
- [ ] **Upload hard limits** (S) — max bytes + content-type allowlist enforced
      server-side on every upload path (admin, MCP, future public).
- [ ] **Light audit log** (M) — every entry write records actor (token id /
      admin user / delivery+user-sub), surface via 07's UI. Teams and clients
      both need "who changed this."
- [ ] **Security headers pass** (S) — CSP, X-Frame-Options, referrer policy on
      admin routes.
- [ ] **Token last-used tracking** (S) — makes stale-token cleanup an informed
      decision instead of a guess.
- [ ] **Content-scope token** (M, gated on custom-admin demand) — entry CRUD
      without schema ops; the right credential for agent-built dashboards.

Done when: a security-minded client's checklist (signatures, CORS, audit,
limits) gets all yeses.
