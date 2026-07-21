/**
 * Feedback Wall — base plugin (wave 1). FEED-2: the client-facing mirror of
 * Pluggie's own operator wall — a tenant collects feedback from THEIR end
 * users, triages it through the same status pipeline we use ourselves.
 * One capability: `feedback_wall`.
 */
export const FEEDBACK_WALL_PLUGIN = {
  id: "feedback_wall",
  version: "1.0.0",
  provides: "feedback_wall",
  name: "Feedback Wall — collect and triage user feedback",
  description:
    "Public feedback intake (bug/idea/friction/praise) with the triage pipeline Pluggie runs on " +
    "itself: new → reviewed → planned → done/dismissed, server-owned statuses, honeypot-guarded " +
    "form, and report recipes. Your users' wall, your triage.",
  structure: {
    intent:
      "Give a tenant app a feedback channel its users can post to from the site, and its team can " +
      "triage with real statuses — the exact loop Pluggie uses for its own platform feedback.",
    baseline: [
      {
        name: "feedback_items",
        displayName: "Feedback",
        publicWrite: true, // the site's feedback widget POSTs straight in
        fields: [
          { name: "summary", label: "Summary", type: "text", required: true, max: 300, searchable: true },
          { name: "detail", label: "Detail", type: "text", max: 5000 },
          { name: "category", label: "Category", type: "enum", indexed: true,
            options: ["bug", "idea", "friction", "praise"] },
          { name: "reporter_email", label: "Reporter email", type: "text",
            max: 254, pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", patternHint: "a valid email address" },
          { name: "page_url", label: "Page", type: "text", max: 500 },
          { name: "honeypot", label: "Honeypot", type: "text", max: 200 },
          { name: "status", label: "Status", type: "enum", indexed: true, writableBy: "none",
            options: ["new", "reviewed", "planned", "done", "dismissed"] },
        ],
        workflow: {
          field: "status",
          initial: "new",
          transitions: [
            { from: "new", to: "reviewed", actors: ["mcp", "admin"] },
            { from: "reviewed", to: "planned", actors: ["mcp", "admin"] },
            { from: ["reviewed", "planned"], to: "done", actors: ["mcp", "admin"] },
            { from: ["new", "reviewed", "planned"], to: "dismissed", actors: ["mcp", "admin"] },
            { from: "dismissed", to: "reviewed", actors: ["mcp", "admin"] }, // re-open
          ],
        },
      },
    ],
    reconcile:
      "Point the site's feedback widget at POST /api/v1/feedback_items sending " +
      "summary/detail/category/reporter_email/page_url/honeypot — status is server-owned. If a " +
      "feedback-ish collection exists, EXTEND it with the pipeline. Pair with the notifications " +
      "base to ping reporters on status changes (via your backend), and with an events email " +
      "action to alert the team on new items.",
  },
  tools: [],
  guidance:
    "You are triaging a user feedback wall. INTAKE is public POST (honeypot: sweep or hook-reject " +
    "non-empty). TRIAGE: new→reviewed as you read; reviewed→planned when scheduled; →done when " +
    "shipped; →dismissed with restraint (dismissed→reviewed re-opens). Statuses are " +
    "writableBy:'none' — only you/admin move them. REPORTS via aggregate_entries: count groupBy " +
    "category (what users talk about), count groupBy status (pipeline health); open = status in " +
    "[new, reviewed, planned]. Weekly digest: query new since last digest, summarize per category.",
  acceptance: [
    "the collection exists; workflow enforces initial status 'new' on every create path",
    "an anonymous POST with summary/category lands as status 'new'",
    "an anonymous POST cannot set status (writableBy:'none' → 403)",
    "count groupBy category and groupBy status both aggregate server-side",
    "dismissed items can be re-opened to reviewed by mcp/admin only",
  ],
};
