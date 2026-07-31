/**
 * The machine-readable NOT-SUPPORTED registry (wall `2479b787`, xvibe).
 *
 * Client teams were hand-maintaining "Pluggie can't do X" lists in their agent
 * system prompts — and the list that motivated this feature was already wrong
 * in two places when it was filed (capacity limits and bucketed aggregates had
 * shipped). A capability an agent wrongly believes missing is work declined;
 * one it wrongly believes present is a confident failure. This registry is
 * served in `get_project_info.briefing.notSupported` so EVERY agent gets the
 * current truth at orientation, and nobody maintains a copy.
 *
 * THE REGISTRY MUST NOT BECOME THE STALE LIST IT REPLACES. Two disciplines:
 *  - every entry cites its BACKLOG id in `ref`, and a smoke test parses
 *    docs/BACKLOG.md and FAILS if any cited row is ✅ Shipped — the same
 *    cross-examination `npm run pm` applies to receipts;
 *  - keep it SHORT: only capabilities agents actually reach for. A hundred-line
 *    registry is a prompt tax nobody reads.
 *
 * `status` vocabulary:
 *  - "not_supported": no current plan — ask via send_feedback if you need it
 *  - "scheduled":     accepted and queued (the ref row says where it stands)
 *  - "declined":      considered and refused — the alternative is the answer
 */

export interface NotSupportedEntry {
  capability: string;
  status: "not_supported" | "scheduled" | "declined";
  /** What to do INSTEAD, today. Every entry must give the agent a next move. */
  alternative: string;
  /** BACKLOG id — the smoke test verifies the cited row is not already shipped. */
  ref: string;
}

export const NOT_SUPPORTED: NotSupportedEntry[] = [
  {
    capability: "SMS / text-message sending (event actions are webhook + email only)",
    status: "scheduled",
    alternative:
      "fire a webhook event action at your own endpoint and send SMS from there; consent fields (e.g. text_opt_in) are storable today",
    ref: "CONN-2",
  },
  {
    capability: "recurring / subscription checkout for TENANT storefronts (tenant /v1/checkout is one-time payment mode only)",
    status: "not_supported",
    alternative:
      "one-time purchases work today; for subscriptions, integrate Stripe Billing directly from your own server",
    ref: "BILL-1",
  },
  {
    capability: "bulk write / bulk delete on the DELIVERY API",
    status: "scheduled",
    alternative:
      "do batches server-side over MCP: bulk_create_entries (500/call) or transact (25 ops, atomic); delivery-side loops are budgeted at 20/min/IP",
    ref: "WP-7",
  },
  {
    capability: "range/absence filters (gt, lt, ne, exists) and keyset cursors on DELIVERY reads (equality + array-membership + offset only)",
    status: "not_supported",
    alternative:
      "run the query server-side over stateless MCP (query_entries has the full operator set + cursors) and serve the result to your client",
    ref: "QRY-1",
  },
  {
    capability: "Idempotency-Key / If-Match (CAS) on delivery POST/PATCH",
    status: "not_supported",
    alternative:
      "retry-safe and compare-and-set writes exist on MCP (create_entry idempotencyKey, update_entry_if); route write paths that need them through your server",
    ref: "WP-1",
  },
  {
    capability: "timezone-aware schedules (cron recurrence is UTC only, no DST adjustment)",
    status: "not_supported",
    alternative: "express the schedule in UTC; if a local-time boundary matters, offset it yourself seasonally",
    ref: "DX-4",
  },
  {
    capability: "platform-side password/credential VERIFICATION (set_credential / verify_credential)",
    status: "not_supported",
    alternative:
      "your auth service verifies credentials; the auth_kit plugin ships the full recipe (argon2id parameters, timing defence, atomic lockout, single-use resets), and writeOnly fields hold set-and-never-read secrets",
    ref: "SEC-3",
  },
  {
    capability: "generic third-party API proxy (store any credential, invoke any external API from the delivery surface)",
    status: "declined",
    alternative:
      "per-category adapters (like email/payments today) open when a tenant names a category — ask via send_feedback for the specific integration you need",
    ref: "CONN-3",
  },
  {
    capability: "project environments / branches (dev-vs-prod copies with promote)",
    status: "scheduled",
    alternative:
      "today: use a second project as a staging copy (export_project carries schema; content must be re-seeded) and mint separate tokens per project",
    ref: "QRY-4",
  },
];
