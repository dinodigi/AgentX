/**
 * Auth Kit — DIY user-management plugin.
 *
 * For tenants who want to run their OWN auth instead of a hosted provider.
 *
 *   Pluggie holds        → identity DATA: users, roles, permissions, orgs,
 *                          memberships, invitations, LOCKOUT state, password
 *                          RESET tokens, auth audit trail
 *   The tenant's service → credential VERIFICATION + sessions: password hashing
 *                          and comparison, JWT issuing, MFA seeds — on their
 *                          infra, same trust class as a before-write hook
 *
 * ── v2: what changed, and the one thing that deliberately did not ───────────
 *
 * v1 said "never store a credential in any field, because there is no masked
 * field type." SEC-1 shipped that field type, so the ban needed re-deriving
 * rather than simply lifting — and re-deriving it produced a sharper rule:
 *
 *   A write-only field is right for a secret you SET and never need back.
 *   It is WRONG for a password hash or a reset token, because VERIFYING either
 *   one means comparing it, and a comparison is a read. Argon2id embeds a random
 *   salt, so you cannot even recompute the hash to compare without first reading
 *   the stored value.
 *
 * That is why credential verification still lives on the tenant's service, and
 * why v2 does NOT move password hashes into Pluggie. The remaining piece —
 * platform-side `verify_credential`, which the reporter of 0ceec805 proposed — is
 * the identity-provider scope DECISIONS-CP9 declined this sprint. It is recorded
 * with a trigger rather than half-built, because a hash Pluggie stores and cannot
 * verify is strictly worse than one it never held.
 *
 * What v2 DOES deliver is the rest of the reporter's five files of
 * security-critical code, as data and as a tested recipe:
 *
 *   lockout            → `users.failed_attempts` / `locked_until`, incremented
 *                        through update_entry_if's ATOMIC increment, so the
 *                        counter cannot be lost to a race (the read-then-write
 *                        version silently undercounts concurrent attempts —
 *                        which is the shape of a bypass, not a rounding error)
 *   password resets    → `password_resets`: computed-uuid token, expires_at, and
 *                        a single-use workflow. Same shape as invitations, which
 *                        the reporter already found correct.
 *   timing defence     → the REAL-dummy-hash rule, stated with its trap: a
 *                        malformed dummy fails on parse and returns instantly,
 *                        reintroducing the exact signal it exists to remove
 *   argon2id params    → one recipe (m=19456, t=2, p=1), plus the rehash-on-login
 *                        upgrade path, so parameter choice stops being per-tenant
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
  version: "2.0.0",
  provides: "identity", // monolith for now — identity/teams split lands with the composition refactor
  name: "Auth Kit — DIY user management",
  description:
    "Build-your-own-auth scaffold: users with an account-lifecycle workflow, roles + a permissions " +
    "registry (RBAC), orgs/teams with one-membership-per-user enforcement, uuid-coded invitations, " +
    "brute-force lockout with a race-free attempt counter, single-use expiring password-reset " +
    "tokens, and a security audit trail. Password hashing and session issuing stay on YOUR auth " +
    "service; the kit ships the argon2id recipe and the account-enumeration defences as tested " +
    "guidance so the highest-risk code in your stack is not rewritten from scratch.",
  structure: {
    intent:
      "Give a project everything user-management needs except credential VERIFICATION: an identity " +
      "registry with a suspension-capable lifecycle, role-based permissions a token issuer can " +
      "embed as claims, team/org membership with database-enforced uniqueness, an invitation flow " +
      "with server-stamped codes, brute-force lockout state, single-use expiring password-reset " +
      "tokens, and an append-only auth audit trail. The tenant's own auth service (their infra) " +
      "hashes and compares passwords and issues JWTs; Pluggie is the system of record it reads " +
      "and writes, and this plugin's guidance is the recipe it should implement.",
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
        // (server-side token), never a bare public POST. NO password hash field:
        // see the header — a value you must COMPARE cannot be write-only, and a
        // readable one would ride out through export/versions/changes.
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
          // ── v2: brute-force lockout, as DATA rather than as advice ──────────
          // Every tenant rebuilt this, and the obvious implementation (read the
          // count, add one, write it back) silently UNDERCOUNTS concurrent
          // attempts — which is the shape of a bypass, not a rounding error. The
          // recipe in `guidance` uses update_entry_if's atomic increment with
          // startingFrom, so the first attempt is atomic too and there is no
          // window in which two failures become one.
          { name: "failed_attempts", label: "Failed attempts", type: "number", integer: true,
            min: 0, writableBy: "none" },
          { name: "last_failed_at", label: "Last failed login", type: "date", writableBy: "none" },
          // Indexed: the unlock sweep filters on it (`lt` now), and that is the
          // one query this collection runs on a schedule.
          { name: "locked_until", label: "Locked until", type: "date", indexed: true, writableBy: "none" },
          // Lets the auth service find accounts still on old argon2id parameters
          // WITHOUT reading any hash — the rehash-on-login upgrade path.
          { name: "password_changed_at", label: "Password changed", type: "date", writableBy: "none" },
          { name: "password_algo", label: "Password algorithm", type: "text", max: 64, indexed: true,
            writableBy: "none" },
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
        // ── v2 ───────────────────────────────────────────────────────────────
        // Password resets, shaped exactly like invitations — the pattern the
        // reporter of 0ceec805 already found correct, applied to the flow they
        // had to build by hand. Single-use is the WORKFLOW (a used token cannot
        // be used again because pending→used is the only route out), expiry is a
        // date the auth service checks, and the token is a server-stamped uuid
        // the client never chooses.
        //
        // The token is NOT write-only, and that is the considered choice: to
        // accept a reset you must COMPARE the presented token to the stored one,
        // and a comparison is a read. It is private instead (no publicRead), so
        // only the auth service's server-side MCP token can see it — the same
        // trust boundary invitation codes have used since v1.
        name: "password_resets",
        displayName: "Password resets",
        fields: [
          { name: "user", label: "User", type: "relation", targetCollection: "users",
            labelField: "email", required: true, writableBy: "none", indexed: true },
          // 128 bits of server-chosen entropy. NEVER let the client supply this.
          { name: "token", label: "Token", type: "text", unique: true, computed: { fn: "uuid" } },
          { name: "requested_at", label: "Requested", type: "date", computed: { fn: "now", on: "create" } },
          { name: "expires_at", label: "Expires", type: "date", indexed: true },
          // For rate-limiting reset REQUESTS, which is its own abuse surface: an
          // unthrottled reset endpoint is a free email cannon aimed at your users.
          { name: "requested_ip", label: "Requested from IP", type: "text", writableBy: "none" },
          { name: "status", label: "Status", type: "enum", indexed: true, writableBy: "none",
            options: ["pending", "used", "expired", "revoked"] },
        ],
        workflow: {
          field: "status",
          initial: "pending",
          transitions: [
            // delivery included so a browser-side reset form can complete through
            // the tenant's endpoint; `used` is terminal, which IS the single-use
            // guarantee — there is no route back to pending.
            { from: "pending", to: "used", actors: ["mcp", "admin", "delivery"] },
            { from: "pending", to: "revoked", actors: ["mcp", "admin"] },
            { from: "pending", to: "expired", actors: ["mcp", "admin"] },
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
              "password_reset_completed", "password_changed", "mfa_enrolled", "mfa_removed",
              "invited", "invite_accepted", "suspended", "reactivated", "role_changed",
              "account_closed",
              // v2: the lockout trail. `locked_out` is the signal a security
              // review asks for first, and `login_blocked` distinguishes "wrong
              // password" from "correct password, account locked" — indispensable
              // when a user swears they typed it right.
              "locked_out", "unlocked", "login_blocked"] },
          { name: "ip", label: "IP", type: "text" },
          { name: "user_agent", label: "User agent", type: "text" },
          { name: "detail", label: "Detail", type: "text" },
        ],
      },
    ],
    reconcile:
      "Apply IN ORDER (permissions → roles → users → orgs → memberships → invitations → " +
      "password_resets → auth_events) — later collections relate to earlier ones. If a " +
      "users/accounts collection already exists, EXTEND it with the missing fields + workflow " +
      "instead of duplicating. Then SEED the RBAC baseline: permissions for each resource you " +
      "actually expose (entries:read, entries:write, members:manage, billing:manage, " +
      "settings:manage) and three roles — admin (all keys), member (read+write), viewer (read) — " +
      "with is_system:true (set via MCP; the field is writableBy:'none'). " +
      "NEVER add a PASSWORD HASH field to any collection here. That is not because secrets cannot " +
      "be stored — writeOnly:true fields exist now and are never returned by any read — but " +
      "because verifying a hash means COMPARING it, and a comparison is a read: argon2id embeds a " +
      "random salt, so you cannot even recompute the hash without the stored value first. Password " +
      "verification therefore stays on your auth service. Use writeOnly for a secret you SET and " +
      "never need back. " +
      "Upgrading an existing v1 install: the new fields (failed_attempts, last_failed_at, " +
      "locked_until, password_changed_at, password_algo) and the password_resets collection are " +
      "PURELY ADDITIVE — re-apply `users` with the full v2 field list (no confirm needed; nothing " +
      "is dropped or retyped) and define password_resets. " +
      "Historical imports: load users at their real statuses with " +
      "allowExplicitWorkflowState:true (audit-stamped).",
  },
  tools: [],
  guidance:
    "You are operating a DIY-auth user-management kit. TRUST MODEL (the one rule that matters): " +
    "Pluggie stores identity DATA; the tenant's own auth service — a small endpoint on their " +
    "infra, same trust class as a before-write hook — owns password HASHING AND COMPARISON, " +
    "session tokens and MFA seeds, and issues JWTs. Do not put a password hash in any field. " +
    "Pluggie DOES now have a write-only field type (writeOnly:true — never returned by MCP, " +
    "delivery, export, versions, the changes feed, webhooks, or the admin form), and it is the " +
    "right home for a secret you SET and never need back. It is the WRONG home for a password hash " +
    "or a reset token, because verifying either one means COMPARING it, and a comparison is a read " +
    "— argon2id embeds a random salt, so you cannot even recompute the hash to compare without " +
    "first reading the stored value. That is the whole reason verification stays on your side, and " +
    "it is worth understanding rather than memorising: apply the same test to any secret you are " +
    "tempted to add. The auth " +
    "service talks to Pluggie two ways: its MCP token SERVER-SIDE for trusted ops (create users, " +
    "transitions, auth_events) — never shipped to a browser — and the delivery token + X-User-Token " +
    "for end-user-scoped reads/writes. " +
    // ── v2: the recipe. This is the code every tenant was rewriting. ─────────
    "PASSWORD RECIPE — implement these four points, do not invent your own; this is the " +
    "security-critical code the kit exists to stop you rewriting, and its failure modes are silent: " +
    "(1) HASHING: argon2id, m=19456 (19 MiB), t=2, p=1, 16-byte random salt, 32-byte output. Store " +
    "the ENCODED string ($argon2id$v=19$m=19456,t=2,p=1$...) in YOUR store — it carries its own " +
    "parameters, which is what makes upgrades possible. Record " +
    "users.password_algo='argon2id:m=19456,t=2,p=1' and password_changed_at on every set, so you " +
    "can find accounts still on old parameters by QUERYING PLUGGIE (password_algo ne the current " +
    "recipe) without reading a single hash. UPGRADE PATH: rehash on next successful login — verify " +
    "with the parameters embedded in the stored hash, then re-hash the plaintext you already have " +
    "in hand with the new ones and update both fields. Never try to mass-rehash: you cannot, and " +
    "arranging to be able to would mean storing plaintext. " +
    "(2) ENUMERATION / TIMING — the subtle one, and the one first versions miss: on an UNKNOWN " +
    "email, still perform a full argon2id verify against a REAL pre-computed dummy hash, then fail. " +
    "A missing or MALFORMED dummy is worse than none — it fails on PARSE and returns immediately, " +
    "reintroducing the exact timing signal it exists to remove. Generate it once at boot by hashing " +
    "a random string with the SAME parameters. Response body and status must be identical for " +
    "unknown-email and wrong-password: one generic 'invalid email or password'. Never 404 an " +
    "unknown account, and never reveal 'account locked' before the password verifies — that answers " +
    "'does this email exist?' for free. " +
    "(3) LOCKOUT: on a failed attempt call update_entry_if with increment " +
    "{field:'failed_attempts', by:1, startingFrom:0} — ATOMIC, and startingFrom makes the FIRST " +
    "attempt atomic too. Do NOT read the count and write it back: two concurrent failures become " +
    "one, and an undercounted lockout is a bypass, not a rounding error. When the returned count " +
    "reaches your threshold (5 is a reasonable default) set locked_until = now + a backoff window " +
    "(15 minutes, doubling on repeat) and log auth_events {type:'locked_out'}. On SUCCESS reset " +
    "failed_attempts to 0 and unset locked_until (null). Check locked_until BEFORE verifying but " +
    "return the SAME generic failure, logging auth_events {type:'login_blocked'} — the distinction " +
    "belongs in the audit trail, not in the response. Unlock sweep: a define_schedule mutate action " +
    "over users where locked_until lt {hoursAgo:0}. " +
    "(4) RESETS: create a password_resets row {user, expires_at: now+1h}; the uuid token is stamped " +
    "server-side (never client-chosen), read it back over MCP and email the link. NON-ENUMERATING " +
    "means the request endpoint returns the same generic 'if that address has an account we have " +
    "emailed it' for known and unknown addresses, in comparable time, and sends nothing for the " +
    "unknown one. On accept: look the token up SERVER-SIDE, require status='pending' AND expires_at " +
    "in the future, set the new hash, then transition pending→used — 'used' is terminal, so " +
    "single-use is the workflow's guarantee rather than your code's. Then revoke the user's other " +
    "pending resets and clear failed_attempts/locked_until: a completed reset must UNLOCK the " +
    "account, or you have locked out the one person who just proved they own it. Rate-limit reset " +
    "REQUESTS per email and per requested_ip — an unthrottled reset endpoint is a free email cannon " +
    "aimed at your own users. Log password_reset_requested / password_reset_completed. " +
    "WIRING IDENTITY: have the issuer put the users row's " +
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
    "link (wire an entry.created email action once an email provider is connected, or send from the " +
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
    "that way when extending; failed_attempts, last_failed_at, locked_until, password_changed_at " +
    "and password_algo join that list, because a browser that can zero its own failed_attempts has " +
    "no lockout at all.",
  acceptance: [
    "all eight baseline collections exist; users workflow enforces initial status 'invited' on every create path",
    "a duplicate email is rejected by the unique constraint with the field named",
    "a second membership for the same user+org is rejected by the unique membership_key",
    "a created invitation carries a server-stamped uuid code and travels pending→accepted; a revoked invitation cannot be accepted",
    "active→suspended is refused for the delivery actor and succeeds for mcp/admin",
    "a delivery write cannot set users.role/status/external_id (writableBy:'none')",
    "no collection in the kit stores a password hash — verification needs a comparison, a comparison is a read",
    // v2 — the four recipe points, each stated so it can actually be checked
    // rather than nodded at.
    "failed_attempts increments ATOMICALLY via update_entry_if {increment, startingFrom:0}: N concurrent failed logins produce a count of N, not fewer",
    "a delivery-token write cannot reset failed_attempts or locked_until (writableBy:'none')",
    "an unknown-email login and a wrong-password login return a byte-identical response, and the unknown-email path performs a full argon2id verify against a REAL dummy hash (a malformed dummy fails on parse and returns early — measure it, do not assume it)",
    "a password_resets token is server-stamped, expires, and is single-use: a token already transitioned to 'used' cannot be used again (the workflow has no route back to pending)",
    "a completed reset clears failed_attempts and locked_until — otherwise the user who just proved ownership stays locked out",
    "the reset REQUEST endpoint answers identically for a known and an unknown address, and emails only the known one",
    "users.password_algo lets you list accounts on outdated argon2id parameters without reading any hash",
  ],
};
