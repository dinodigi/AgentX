# 03 · MCP surface ✅ DONE 2026-07-05

Purpose: the agent's cockpit. Now 23 self-describing tools with guardrails.
Built smallest-first so the client generator snapshots a finished surface.

## Sub-features

- [x] **get_client_code** (M) — the headline: returns a generated, typed TS
      client built from the live schema (per-collection types, capability-gated
      CRUD + query functions, delivery-token + X-User-Token handling). Kills the
      observed friction of every session hand-rolling lib/agentx.ts. Generator
      reads capability tables (lib/mcp/client-code.ts) so 04's additions
      regenerate for free. Smoke test compiles the output under tsc --strict
      and runs it against the live delivery API.
- [x] **get_deliveries** (S) — read the webhook/email delivery log over MCP so
      agents debug their own event wiring without a human opening the admin.
- [x] **Error code registry** (S) — stable machine codes alongside fix-hint
      text (`Error [E_*]: message`); registry in lib/error-codes.ts, exposed on
      the MCP GET liveness check. E_CONFIRM_REQUIRED rides on plan responses.
- [x] **Result pagination conventions** (S) — explicit hasMore/nextOffset
      envelopes on query_entries/list_assets (and the new log tools); exact via
      limit+1 probe, deterministic (createdAt, id) ordering.
- [x] **get_audit_log** (S, after 02) — same argument as get_deliveries.

Done when: a fresh agent session can orient, build, integrate, and debug a
project end-to-end without reading source or asking a human.
