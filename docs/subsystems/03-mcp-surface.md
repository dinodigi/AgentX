# 03 · MCP surface (grade A-)

Purpose: the agent's cockpit. 19 self-describing tools with guardrails; the
gaps are the ones agents route around by hand.

## Sub-features

- [ ] **get_client_code** (M) — the headline: returns a generated, typed TS
      client built from the live schema (per-collection types, CRUD + query
      functions, delivery-token + X-User-Token handling). Kills the observed
      friction of every session hand-rolling lib/agentx.ts. Generator reads
      capabilities so 04's additions regenerate for free.
- [ ] **get_deliveries** (S) — read the webhook/email delivery log over MCP so
      agents debug their own event wiring without a human opening the admin.
- [ ] **Error code registry** (S) — stable machine codes alongside fix-hint
      text (E_VALIDATION, E_CONFIRM_REQUIRED, E_SCOPE…); agents branch on codes.
- [ ] **Result pagination conventions** (S) — explicit hasMore/nextOffset in
      list-shaped tool results instead of implicit truncation.
- [ ] **get_audit_log** (S, after 02) — same argument as get_deliveries.

Done when: a fresh agent session can orient, build, integrate, and debug a
project end-to-end without reading source or asking a human.
