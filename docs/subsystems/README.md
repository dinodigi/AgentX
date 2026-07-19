# Subsystem work plan

Each subsystem is a feature with its own backlog. Numbering = work order.
Sizes: S (≤half day) · M (1–2 days) · L (3+ days). Items marked **gated** wait
for their trigger (evidence, user accounts, deploy, or tenants) per the original roadmap (now docs/archive/ROADMAP.md).

| # | Subsystem | Grade | Why this position |
|---|-----------|-------|-------------------|
| 01 | Ops & quality | D | Tests + export protect everything; nothing else is safe to change first |
| 02 | Security | B | Trust floor (HMAC, CORS, audit) before exposure grows |
| 03 | MCP surface | A- | get_client_code multiplies agent productivity for all later work |
| 04 | Query layer | B | Aggregations/operators unlock real app screens; the SDK generates from these |
| 05 | Data layer | A- | Constraints + update_entry_if = business-logic rungs 1–2 |
| 06 | Delivery API | B+ | Public uploads need 02's limits; caching is cheap after |
| 07 | Admin | B+ | Client-facing polish; audit-log UI needs 02 first |
| 08 | Events | B- | Conditional actions reuse 04's where-clause machinery |
| 09 | Identity | B | Big items need a real Clerk (user) or evidence (roles) |
| 10 | Connectors | B- | Mostly platform-gated (OAuth flows, Neon) |

Dependency notes: 02→07 (audit UI), 02→06 (upload limits), 04→08 (conditions),
04→03 (SDK exposes query surface — build 03's generator to read capabilities,
regenerate free when 04 lands).
