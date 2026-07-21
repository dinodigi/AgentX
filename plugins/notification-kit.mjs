/**
 * Notification Kit — in-app notifications for a tenant's OWN app users.
 *
 * Tenant-side counterpart of the platform's console "needs attention" (the
 * Pluggie-admin bell itself is BACKLOG NOTIF-1 — not this). Pairs with
 * auth_kit: `recipient` targets the same `users` collection.
 *
 * Everything maps to shipped primitives:
 *   realtime delivery   → the changes feed (GET /api/v1/changes + SSE) IS the
 *                         transport — clients get live notifications with zero
 *                         extra infra (worst-case lag ~2-4s)
 *   unread badge        → count where read_at exists:false (absence query)
 *   idempotent sends    → optional dedupe_key with unique:true (partial index —
 *                         rows without it repeat freely, rows with it can't
 *                         double-send)
 *   one pref per topic  → computed template pref_key + unique (the
 *                         no-double-book pattern)
 *   announcement governance → workflow draft → published → archived,
 *                         publish gated to mcp/admin
 *   spoof-proofing      → recipient/user are writableBy:'none' and the feed
 *                         collections have no publicWrite — only the trusted
 *                         backend (MCP, server-side) produces notifications
 * Seeded GLOBAL (operator-authored, first-party) via seed-notification-kit-plugin.mjs.
 */
export const NOTIFICATION_KIT_PLUGIN = {
  id: "notification_kit",
  version: "1.1.0",
  provides: "notifications", // requires:["identity"] arrives WITH the auth_kit split (until then it ships its minimal users fallback)
  name: "Notification Kit — in-app notifications",
  description:
    "In-app notification system for the app you build on Pluggie: per-user notification feed with " +
    "unread tracking and idempotent sends, per-topic mute preferences, and workflow-governed " +
    "broadcast announcements. Realtime for free via the changes feed/SSE — no extra infra. Pairs " +
    "with auth_kit (notifies its users).",
  structure: {
    intent:
      "Give a tenant app a complete notification layer: producers (the app backend or an agent, " +
      "over MCP) create per-user notifications and broadcast announcements; consumers read their " +
      "own feed over delivery, track unread via read_at, mute topics via preferences, and get " +
      "live updates by following the platform changes feed — the notification transport is the " +
      "realtime surface Pluggie already ships.",
    baseline: [
      {
        // Minimal identity target so `recipient` resolves on a fresh project.
        // If `users` ALREADY exists (e.g. auth_kit), SKIP this entry — never
        // redefine an existing users with this minimal shape (define_collection
        // is full-replace; the destructive gate will rightly block you).
        name: "users",
        displayName: "Users",
        fields: [
          { name: "email", label: "Email", type: "text", required: true, unique: true, searchable: true,
            max: 254, pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", patternHint: "a valid email address" },
          { name: "name", label: "Name", type: "text", searchable: true },
        ],
      },
      {
        name: "notifications",
        displayName: "Notifications",
        // No publicWrite and recipient is writableBy:'none' — only the trusted
        // backend (MCP, server-side) can address a notification to someone.
        fields: [
          { name: "recipient", label: "Recipient", type: "relation", targetCollection: "users", labelField: "email", required: true, indexed: true, writableBy: "none" },
          { name: "kind", label: "Kind", type: "enum", indexed: true,
            options: ["info", "success", "warning", "alert"] },
          // App-defined stream, e.g. "billing", "comments", "system" — what
          // preferences mute and reports group by.
          { name: "topic", label: "Topic", type: "text", max: 64, indexed: true },
          { name: "title", label: "Title", type: "text", required: true, max: 200 },
          { name: "body", label: "Body", type: "text", max: 2000 },
          { name: "link", label: "Link", type: "text", max: 500 },
          // Id of the thing this is about (order id, comment id…) — click-through + dedupe.
          { name: "ref", label: "Ref", type: "text", max: 128 },
          // OPTIONAL idempotency: set it (e.g. "order_shipped|<orderId>|<userId>")
          // and a duplicate send is rejected by the DB; leave it unset for
          // notifications that may legitimately repeat.
          { name: "dedupe_key", label: "Dedupe key", type: "text", max: 200, unique: true, writableBy: "none" },
          // Unset = unread. The unread badge is: count where read_at exists:false.
          { name: "read_at", label: "Read at", type: "date" },
          { name: "archived_at", label: "Archived at", type: "date" },
          { name: "expires_at", label: "Expires at", type: "date" },
        ],
      },
      {
        name: "notification_prefs",
        displayName: "Notification preferences",
        fields: [
          { name: "user", label: "User", type: "relation", targetCollection: "users", labelField: "email", required: true, indexed: true, writableBy: "none" },
          // Matches notifications.topic; "all" = the global switch.
          { name: "topic", label: "Topic", type: "text", required: true, max: 64 },
          { name: "muted", label: "Muted", type: "boolean" },
          // Channel switches — in_app is live today; email/sms activate when the
          // project wires those connectors (producers must respect them).
          { name: "in_app", label: "In-app", type: "boolean" },
          { name: "email", label: "Email", type: "boolean" },
          // One pref row per user+topic, DB-enforced.
          { name: "pref_key", label: "Pref key", type: "text", unique: true,
            computed: { fn: "template", template: "{{user}}|{{topic}}" } },
        ],
      },
      {
        name: "announcements",
        displayName: "Announcements",
        fields: [
          { name: "title", label: "Title", type: "text", required: true, max: 200, searchable: true },
          { name: "body", label: "Body", type: "richtext" },
          { name: "kind", label: "Kind", type: "enum", options: ["info", "success", "warning", "alert"] },
          { name: "link", label: "Link", type: "text", max: 500 },
          { name: "audience", label: "Audience", type: "enum", options: ["all", "admins"] },
          { name: "starts_at", label: "Starts", type: "date" },
          { name: "ends_at", label: "Ends", type: "date" },
          { name: "status", label: "Status", type: "enum", indexed: true, writableBy: "none",
            options: ["draft", "published", "archived"] },
        ],
        // Publishing is a governed act: only mcp/admin move an announcement out
        // of draft — a delivery client can never broadcast to everyone.
        workflow: {
          field: "status",
          initial: "draft",
          transitions: [
            { from: "draft", to: "published", actors: ["mcp", "admin"] },
            { from: "published", to: "archived", actors: ["mcp", "admin"] },
            { from: "archived", to: "published", actors: ["mcp", "admin"] }, // re-run a campaign
            { from: "draft", to: "archived", actors: ["mcp", "admin"] }, // abandon a draft
          ],
        },
      },
    ],
    reconcile:
      "Apply IN ORDER. `users` first — but ONLY if the project has no users collection yet; when " +
      "auth_kit (or any identity registry) is already applied, SKIP the minimal users entry and " +
      "point at the existing collection (never redefine it with the minimal shape — full-replace " +
      "would drop fields and the destructive gate will block you). Then notifications → " +
      "notification_prefs → announcements. If the app's identity collection has a different name, " +
      "swap targetCollection on recipient/user accordingly. Wire delivery read scoping once the " +
      "project's identity connector exists: notifications and notification_prefs must be readable " +
      "ONLY by their own user (owner-scoped access rules keyed on the authenticated identity); " +
      "until then they are MCP/admin-only surfaces, which is safe. Do not enable publicWrite on " +
      "any kit collection.",
  },
  tools: [],
  guidance:
    "You are operating an in-app notification system. PRODUCING (backend/agent over MCP, " +
    "server-side): before creating a notification, check prefs — query notification_prefs where " +
    "user eq <id> and topic in [<topic>,'all']; skip muted (or in_app false) users. Create " +
    "notifications {recipient, kind, topic, title, body?, link?, ref?}; for events that must " +
    "never double-send (an order-shipped ping, a digest) set dedupe_key " +
    "'<topic>|<ref>|<recipient>' and treat the unique conflict as 'already sent' — success, not " +
    "an error. Notifications that may repeat (new comment) leave dedupe_key unset. FAN-OUT for a " +
    "cohort = bulk_create_entries (100/batch). CONSUMING (the tenant app, delivery surface): the " +
    "feed = query notifications where recipient eq <me> ordered createdAt desc; UNREAD BADGE = " +
    "count where read_at exists:false; MARK READ = PATCH {read_at: now}; mark-all-read iterates " +
    "(no delivery bulk yet). REALTIME: follow GET /api/v1/changes?since= or the SSE stream and " +
    "react to notifications-collection changes — that IS the push channel (worst-case lag ~2-4s; " +
    "reconcile with a full query periodically). ANNOUNCEMENTS: clients render published rows " +
    "where starts_at lte now and ends_at gte now (or unset), filtered by audience; publishing is " +
    "draft→published via MCP/admin ONLY — never let a delivery actor broadcast. Need per-user " +
    "read-tracking on a broadcast? Fan it out into notifications rows instead (dedupe_key " +
    "'announce|<announcementId>|<userId>'). HYGIENE (run as a periodic sweep): delete " +
    "notifications where expires_at lt now, and archive read ones older than ~90 days " +
    "(read_at lt cutoff → PATCH archived_at). REPORTS via aggregate_entries: unread depth = " +
    "count(read_at exists:false) groupBy kind; volume by topic = count groupBy topic (topic is " +
    "text — group client-side from query results, or promote hot topics to an enum); " +
    "announcements by status = count groupBy status. CHANNELS: this kit is in-app; when the " +
    "project gains a Resend connector, honor prefs.email by wiring an entry.created email action " +
    "on notifications (when-clause on kind) or send from the backend — never bypass a mute.",
  acceptance: [
    "all four baseline collections exist (users skipped when an identity collection was already present); announcements workflow enforces initial status 'draft' on every create path",
    "a second notification_prefs row for the same user+topic is rejected by the unique pref_key",
    "two notifications WITHOUT dedupe_key coexist; a duplicate WITH the same dedupe_key is rejected",
    "the unread query (read_at exists:false) returns exactly the unread rows, and marking one read removes it from that set",
    "draft→published is refused for the delivery actor and succeeds for mcp/admin",
    "a delivery write cannot set recipient/user/dedupe_key (writableBy:'none') and no kit collection is publicWrite",
  ],
};
