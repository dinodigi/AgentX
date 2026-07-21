/**
 * Waitlist — base plugin (wave 1). Our own marketing intake, generalized:
 * public signups, uuid invite codes, waiting → invited → joined lifecycle.
 * One capability: `waitlist`.
 */
export const WAITLIST_PLUGIN = {
  id: "waitlist",
  version: "1.0.0",
  provides: "waitlist",
  name: "Waitlist — signups to invitations",
  description:
    "Public waitlist signups with duplicate protection, server-stamped uuid invite codes, and a " +
    "waiting → invited → joined lifecycle. The pattern Pluggie's own marketing intake runs on, " +
    "packaged.",
  structure: {
    intent:
      "Collect signups from a public form, keep them deduplicated, and run an invitation flow " +
      "where codes are server-minted and single-purpose.",
    baseline: [
      {
        name: "waitlist_signups",
        displayName: "Waitlist signups",
        publicWrite: true, // the public form POSTs straight in
        fields: [
          { name: "email", label: "Email", type: "text", required: true, unique: true, searchable: true,
            max: 254, pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", patternHint: "a valid email address" },
          { name: "name", label: "Name", type: "text", max: 120, searchable: true },
          { name: "source", label: "Source", type: "text", max: 80 },
          { name: "honeypot", label: "Honeypot", type: "text", max: 200 }, // bots fill it; sweep or hook rejects
          // Server-minted invite code — private by default, read over MCP.
          { name: "invite_code", label: "Invite code", type: "text", unique: true, writableBy: "none",
            computed: { fn: "uuid" } },
          { name: "invited_at", label: "Invited at", type: "date", writableBy: "none" },
          { name: "status", label: "Status", type: "enum", indexed: true, writableBy: "none",
            options: ["waiting", "invited", "joined", "removed"] },
        ],
        workflow: {
          field: "status",
          initial: "waiting",
          transitions: [
            { from: "waiting", to: "invited", actors: ["mcp", "admin"] },
            { from: "invited", to: "joined", actors: ["mcp", "admin", "delivery"] },
            { from: ["waiting", "invited"], to: "removed", actors: ["mcp", "admin"] },
          ],
        },
      },
    ],
    reconcile:
      "If a subscribers/signups collection already exists, EXTEND it with the lifecycle instead of " +
      "duplicating. Point the site's form at POST /api/v1/waitlist_signups sending " +
      "email/name/source/honeypot only — status, invite_code, and invited_at are server-owned. " +
      "Position is derived (createdAt order), never stored.",
  },
  tools: [],
  guidance:
    "You are operating a waitlist. SIGNUP is public POST; a duplicate email is REJECTED by the " +
    "unique constraint — treat that as 'already on the list' (success-shaped), not an error. " +
    "POSITION = the row's rank by createdAt ascending among status 'waiting' (query, don't store). " +
    "INVITE = transition waiting→invited + set invited_at (MCP update; both are writableBy:'none') " +
    "— then send the invite_code link via your email action or backend. JOIN = the invitee's flow " +
    "verifies the code server-side and transitions invited→joined (delivery actor allowed). " +
    "HONEYPOT: sweep or hook-reject any signup with a non-empty honeypot. Batch-invite the next N: " +
    "query waiting ordered createdAt asc limit N, then invite each. REPORTS: count by status; " +
    "signups per source via groupBy source is not possible (text) — promote source to enum if you " +
    "need it server-side.",
  acceptance: [
    "the collection exists; workflow enforces initial status 'waiting' on every create path",
    "anonymous POST with email/name lands; a duplicate email is rejected with the field named",
    "anonymous POST cannot set status/invite_code/invited_at (writableBy:'none' → 403)",
    "every signup carries a server-stamped uuid invite_code",
    "waiting→invited is mcp/admin only; invited→joined allows the delivery actor",
  ],
};
