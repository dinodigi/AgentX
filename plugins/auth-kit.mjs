/**
 * Auth Kit — DIY user-management plugin.
 *
 * For tenants who want to run their OWN auth instead of a hosted provider.
 * The kit is deliberately CREDENTIAL-FREE: Pluggie has no masked/write-only
 * field type (BACKLOG SEC-1), so a password/token stored in any field would be
 * readable in the admin, exports, versions, and the changes feed. Therefore:
 *
 *   Pluggie holds        → identity DATA: users, roles, permissions, orgs,
 *                          memberships, invitations, auth audit trail
 *   The tenant's service → CREDENTIALS + sessions: password hashing, token
 *                          issuing (JWTs), MFA seeds — on their infra, exactly
 *                          like before-write hooks (the "no hosted code" line)
 *
 * Everything else maps to shipped primitives:
 *   account lifecycle   → `users` workflow (invited → active ↔ suspended → deactivated)
 *   one-per-key rules   → computed template + unique (membership_key), unique email
 *   invite codes        → computed uuid (server-stamped, private by default)
 *   RBAC                → `roles.permissions` = array of registry keys; the
 *                         tenant's issuer embeds them as JWT claims; access
 *                         rules match {claim} presets + access.org row scoping
 *   privilege escalation→ role/status/external_id are writableBy:'none'
 *   audit               → `auth_events` + the platform audit log
 * Seeded GLOBAL (operator-authored, first-party) via seed-auth-kit-plugin.mjs.
 */
export const AUTH_KIT_PLUGIN = {
  id: "auth_kit",
  version: "1.1.0",
  provides: "identity", // monolith for now — identity/teams split lands with the composition refactor
  name: "Auth Kit — DIY user management",
  description:
    "Build-your-own-auth scaffold: users with an account-lifecycle workflow, roles + a permissions " +
    "registry (RBAC), orgs/teams with one-membership-per-user enforcement, uuid-coded invitations, " +
    "and a security audit trail. Credential-free by design — password hashing and session issuing " +
    "stay on YOUR auth service; Pluggie stores identity data and enforces the rules around it.",
  structure: {
    intent:
      "Give a project everything user-management needs EXCEPT the credentials: an identity " +
      "registry with a suspension-capable lifecycle, role-based permissions a token issuer can " +
      "embed as claims, team/org membership with database-enforced uniqueness, an invitation flow " +
      "with server-stamped codes, and an append-only auth audit trail. The tenant's own auth " +
      "service (their infra) verifies passwords and issues JWTs; Pluggie is the system of record " +
      "it reads and writes.",
    baseline: [
      {
        name: "permissions",
        displayName: "Permissions",
        fields: [
          // resource:action keys, e.g. "entries:read", "billing:manage", "reports:*"
          { name: "key", label: "Key", type: "text", required: true, unique: true, max: 64,
            pattern: "^[a-z0-9_]+:[a-z0-9_*]+$", patternHint: "resource:action, e.g. entries:read" },
          { name: "label", label: "Label", type: "text", required: true },
          { name: "description", label: "Description", type: "text" },
          { name: "resource", label: "Resource", type: "text", indexed: true },
        ],
      },
      {
        name: "roles",
        displayName: "Roles",
        fields: [
          { name: "name", label: "Name", type: "text", required: true, unique: true, searchable: true },
          { name: "description", label: "Description", type: "text" },
          // Keys from the permissions registry. Array items are scalars, so the
          // FK is by convention — guidance says validate against the registry.
          { name: "permissions", label: "Permission keys", type: "array", maxItems: 100,
            item: { type: "text", max: 64, pattern: "^[a-z0-9_]+:[a-z0-9_*]+$" } },
          // Protects seeded roles (admin/member/viewer) from casual deletion.
          { name: "is_system", label: "System role", type: "boolean", writableBy: "none" },
        ],
      },
      {
        name: "users",
        displayName: "Users",
        // NO publicWrite: sign-up goes through the tenant's auth service
        // (server-side token), never a bare public POST. NO password field —
        // ever. Credentials live outside Pluggie by design.
        fields: [
          { name: "email", label: "Email", type: "text", required: true, unique: true, searchable: true,
            max: 254, pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", patternHint: "a valid email address" },
          { name: "name", label: "Name", type: "text", searchable: true },
          { name: "avatar", label: "Avatar", type: "asset" },
          // The `sub` your token issuer puts in JWTs — how delivery identity
          // maps to this row. Set once by the auth service; web can never touch it.
          { name: "external_id", label: "External id (sub)", type: "text", unique: true, indexed: true, writableBy: "none" },
          { name: "role", label: "Role", type: "relation", targetCollection: "roles", labelField: "name", writableBy: "none" },
          { name: "email_verified", label: "Email verified", type: "boolean", writableBy: "none" },
          { name: "mfa_enrolled", label: "MFA enrolled", type: "boolean", writableBy: "none" },
          { name: "last_login_at", label: "Last login", type: "date", writableBy: "none" },
          { name: "status", label: "Status", type: "enum", indexed: true, writableBy: "none",
            options: ["invited", "active", "suspended", "deactivated"] },
        ],
        workflow: {
          field: "status",
          initial: "invited",
          transitions: [
            // Activation: the auth service confirms an invite/verification —
            // delivery actor included so a delivery-token flow can activate.
            { from: "invited", to: "active", actors: ["mcp", "admin", "delivery"] },
            // Suspension is an ADMIN power — delivery can never suspend anyone.
            { from: "active", to: "suspended", actors: ["mcp", "admin"] },
            { from: "suspended", to: "active", actors: ["mcp", "admin"] },
            // A user may close their own account (owner-gated on the write side).
            { from: "active", to: "deactivated", actors: ["mcp", "admin", "delivery"] },
            { from: "suspended", to: "deactivated", actors: ["mcp", "admin"] },
            { from: "deactivated", to: "active", actors: ["mcp", "admin"] }, // reactivation
          ],
        },
      },
      {
        name: "orgs",
        displayName: "Organizations",
        fields: [
          { name: "name", label: "Name", type: "text", required: true, searchable: true },
          { name: "slug", label: "Slug", type: "text", unique: true,
            computed: { fn: "slugify", from: "name" } },
          { name: "owner", label: "Owner", type: "relation", targetCollection: "users", labelField: "email", writableBy: "none" },
        ],
      },
      {
        name: "memberships",
        displayName: "Memberships",
        fields: [
          { name: "user", label: "User", type: "relation", targetCollection: "users", labelField: "email", required: true, writableBy: "none", indexed: true },
          { name: "org", label: "Organization", type: "relation", targetCollection: "orgs", labelField: "name", required: true, writableBy: "none", indexed: true },
          { name: "role", label: "Role", type: "relation", targetCollection: "roles", labelField: "name", writableBy: "none" },
          // One membership per user per org — DB-enforced, same pattern as the
          // CRM's no-double-book slot_key.
          { name: "membership_key", label: "Membership key", type: "text", unique: true,
            computed: { fn: "template", template: "{{user}}|{{org}}" } },
          { name: "status", label: "Status", type: "enum", indexed: true,
            options: ["active", "removed"] },
        ],
      },
      {
        name: "invitations",
        displayName: "Invitations",
        fields: [
          { name: "email", label: "Email", type: "text", required: true, indexed: true,
            max: 254, pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", patternHint: "a valid email address" },
          { name: "org", label: "Organization", type: "relation", targetCollection: "orgs", labelField: "name" },
          { name: "role", label: "Role", type: "relation", targetCollection: "roles", labelField: "name" },
          // Server-stamped invite code. Private by default (no publicRead) —
          // your auth service reads it over its token and emails the link.
          // Single-use via the workflow; short-lived via expires_at.
          { name: "code", label: "Code", type: "text", unique: true,
            computed: { fn: "uuid" } },
          { name: "invited_by", label: "Invited by", type: "relation", targetCollection: "users", labelField: "email", writableBy: "none" },
          { name: "expires_at", label: "Expires", type: "date" },
          { name: "status", label: "Status", type: "enum", indexed: true, writableBy: "none",
            options: ["pending", "accepted", "revoked", "expired"] },
        ],
        workflow: {
          field: "status",
          initial: "pending",
          transitions: [
            { from: "pending", to: "accepted", actors: ["mcp", "admin", "delivery"] },
            { from: "pending", to: "revoked", actors: ["mcp", "admin"] },
            { from: "pending", to: "expired", actors: ["mcp", "admin"] }, // stale sweep
          ],
        },
      },
      {
        name: "auth_events",
        displayName: "Auth events",
        // Append-only security trail, written by the trusted auth service over
        // MCP (server-side). Deliberately NOT publicWrite — the delivery token
        // is embedded in sites, and a spammable audit log is worse than none.
        fields: [
          { name: "user", label: "User", type: "relation", targetCollection: "users", labelField: "email", indexed: true },
          { name: "type", label: "Type", type: "enum", required: true, indexed: true,
            options: ["login", "logout", "login_failed", "signup", "password_reset_requested",
              "password_changed", "mfa_enrolled", "mfa_removed", "invited", "invite_accepted",
              "suspended", "reactivated", "role_changed", "account_closed"] },
          { name: "ip", label: "IP", type: "text" },
          { name: "user_agent", label: "User agent", type: "text" },
          { name: "detail", label: "Detail", type: "text" },
        ],
      },
    ],
    reconcile:
      "Apply IN ORDER (permissions → roles → users → orgs → memberships → invitations → " +
      "auth_events) — later collections relate to earlier ones. If a users/accounts collection " +
      "already exists, EXTEND it with the missing fields + workflow instead of duplicating. Then " +
      "SEED the RBAC baseline: permissions for each resource you actually expose (entries:read, " +
      "entries:write, members:manage, billing:manage, settings:manage) and three roles — " +
      "admin (all keys), member (read+write), viewer (read) — with is_system:true (set via MCP; " +
      "the field is writableBy:'none'). NEVER add a password/hash/token/secret/otp field to ANY " +
      "collection here — credentials belong to the tenant's auth service, not the content store. " +
      "Historical imports: load users at their real statuses with " +
      "allowExplicitWorkflowState:true (audit-stamped).",
  },
  tools: [],
  guidance:
    "You are operating a DIY-auth user-management kit. TRUST MODEL (the one rule that matters): " +
    "Pluggie stores identity DATA; the tenant's own auth service — a small endpoint on their " +
    "infra, same trust class as a before-write hook — owns CREDENTIALS (password hashes, session " +
    "tokens, MFA seeds) and issues JWTs. Never store any credential in any field: there is no " +
    "masked field type, so it would be readable in admin/exports/versions/changes. The auth " +
    "service talks to Pluggie two ways: its MCP token SERVER-SIDE for trusted ops (create users, " +
    "transitions, auth_events) — never shipped to a browser — and the delivery token + X-User-Token " +
    "for end-user-scoped reads/writes. WIRING IDENTITY: have the issuer put the users row's " +
    "external_id as the JWT sub, plus role name and permission keys as claims; register the " +
    "issuer via the project's auth connector (JWKS) so access presets ({claim:'role',equals:'admin'}, " +
    "owner, access.org) enforce natively on delivery. CLERK SPECIFICS (field-tested, v1.0.1): " +
    "configure claims under Clerk Dashboard → Sessions → 'Customize session token' — THAT is what " +
    "populates the default token from getToken(), i.e. what you forward as X-User-Token (e.g. " +
    '{"role":"{{user.public_metadata.role}}"}). Clerk\'s separately-named "JWT Templates" feature ' +
    "does NOT apply to the default token — templates only activate when code explicitly calls " +
    "getToken({template:'name'}); configuring one and expecting default-token claims silently " +
    "ships no claims and locks users out. RBAC: permissions registry keys are " +
    "resource:action; roles carry a key array — validate every key against the registry before " +
    "writing (the array is by-convention, not an FK). Changing a role's permissions changes what " +
    "NEW tokens carry — sessions refresh on the issuer's schedule, so revocation latency = token " +
    "TTL; keep TTLs short. FLOWS: INVITE = create invitations {email, org?, role} → the uuid code " +
    "is stamped server-side (read it back over MCP; it is private by default) → email the accept " +
    "link (wire an entry.created email action once a Resend connector exists, or send from the " +
    "auth service) → on accept, the auth service verifies code + expiry SERVER-SIDE, creates the " +
    "user (or transitions invited→active), creates the membership, transitions the invitation " +
    "pending→accepted. Expired sweep: query pending where expires_at lt now → transition to " +
    "expired. SUSPENSION = active→suspended (mcp/admin ONLY — delivery cannot suspend); the auth " +
    "service MUST check users.status on every login and refuse suspended/deactivated accounts — " +
    "and log auth_events {type:'suspended'|'login_failed'}. MEMBERSHIPS: one per user+org is " +
    "DB-enforced by membership_key — catch the unique conflict as 'already a member'. Removing a " +
    "member = status→removed (keep the row for history). AUDIT: write auth_events for every " +
    "auth-relevant action; REPORTS via aggregate_entries: users groupBy status (account health), " +
    "auth_events groupBy type (activity mix), login_failed count per user/day (brute-force " +
    "signal), memberships groupBy org (team sizes). PRIVILEGE ESCALATION GUARDS: role, status, " +
    "external_id, invited_by, is_system are writableBy:'none' — only MCP/admin set them; keep it " +
    "that way when extending.",
  acceptance: [
    "all seven baseline collections exist; users workflow enforces initial status 'invited' on every create path",
    "a duplicate email is rejected by the unique constraint with the field named",
    "a second membership for the same user+org is rejected by the unique membership_key",
    "a created invitation carries a server-stamped uuid code and travels pending→accepted; a revoked invitation cannot be accepted",
    "active→suspended is refused for the delivery actor and succeeds for mcp/admin",
    "a delivery write cannot set users.role/status/external_id (writableBy:'none')",
    "no collection in the kit contains a password/hash/token/secret/otp-shaped field",
  ],
};
