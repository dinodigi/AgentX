/**
 * The MCP tool surface, grouped for a HUMAN reader — the developers page and the
 * public docs render from this.
 *
 * WHY IT IS HERE AND NOT HAND-WRITTEN IN A PAGE. The developers page used to
 * carry its own literal list. It named 42 tools while the surface shipped 61, so
 * NINETEEN tools were invisible to anyone reading our documentation: the whole
 * plugin system, blocks, the SEO/site-audit set, inbound email, and — most
 * expensively — `mint_delivery_token` and its siblings. An integrator asked us
 * in writing whether short-lived scoped tokens could be minted, at a moment when
 * the tools that do it were absent from every public page.
 *
 * Grouping is editorial: the contract carries no category, and "SCHEMA vs READS"
 * is a judgement about how a person learns the surface, not a fact derivable
 * from a tool definition. So it cannot be generated — but it CAN be made
 * impossible to leave incomplete. `scripts/smoke/116-public-truth.test.mjs`
 * lists the live tools and asserts this registry covers them exactly: no tool
 * missing, no name that no longer exists. Adding a tool therefore fails the
 * suite until someone files it into a group, which is the only mechanism that
 * would have caught the original drift.
 *
 * Same shape as the field-primitive count in `list_field_types`: state it once,
 * pin it to the wire, and let the build refuse to be wrong.
 */

export interface ToolGroup {
  /** Display label. */
  label: string;
  /** One line on what this group is FOR — the reason a reader would open it. */
  blurb: string;
  /** Tool names, in the order a newcomer should meet them. */
  tools: string[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    label: "SCHEMA",
    blurb: "Define the data model. Destructive changes return a plan and wait for confirm.",
    tools: [
      "define_collection",
      "list_collections",
      "describe_collection",
      "delete_collection",
      "list_field_types",
      "define_block",
      "list_blocks",
      "delete_block",
    ],
  },
  {
    label: "WRITES",
    blurb: "Create and change content, including compare-and-set and multi-op transactions.",
    tools: ["create_entry", "update_entry", "update_entry_if", "delete_entry", "bulk_create_entries", "transact"],
  },
  {
    label: "READS",
    blurb: "Filter, sort, page, aggregate and full-text search — schema-validated, never an expression language.",
    tools: ["query_entries", "get_entry", "count_entries", "aggregate_entries", "search_entries"],
  },
  {
    label: "SAFETY NET",
    blurb: "Soft delete with a 30-day sweep, and per-entry version history you can restore from.",
    tools: [
      "list_trash",
      "restore_entry",
      "purge_entry",
      "empty_trash",
      "list_entry_versions",
      "restore_entry_version",
    ],
  },
  {
    label: "AUTOMATION",
    blurb: "Schedules, the job queue, before-write hooks, and inbound email into a collection.",
    tools: [
      "define_schedule",
      "list_schedules",
      "delete_schedule",
      "list_jobs",
      "cancel_job",
      "test_hook",
      "configure_inbound",
      "disable_inbound",
    ],
  },
  {
    label: "OBSERVABILITY",
    blurb: "What happened, and the change feed you sync against instead of polling.",
    tools: ["get_changes", "get_deliveries", "refire_delivery", "get_audit_log"],
  },
  {
    label: "ACCESS & TOKENS",
    blurb: "Mint, list and revoke delivery tokens — including browser-safe read-only ones.",
    tools: ["mint_delivery_token", "list_delivery_tokens", "revoke_delivery_token"],
  },
  {
    label: "PLUGINS",
    blurb: "Package a schema + automations as a reusable unit, then apply it to a project.",
    tools: ["define_plugin", "list_plugins", "get_plugin", "enable_plugin", "disable_plugin", "delete_plugin"],
  },
  {
    label: "SEO & SITE AUDIT",
    blurb: "Fetch and score a live page, then audit a whole site against it.",
    tools: ["fetch_page", "score_page", "audit_site"],
  },
  {
    label: "ASSETS",
    blurb: "Upload files, list and delete them; derived images are served with transforms.",
    tools: ["upload_asset", "list_assets", "delete_asset"],
  },
  {
    label: "PORTABILITY",
    blurb: "Export content or a whole project definition, and import it back — round-trip.",
    tools: ["export_entries", "export_project", "import_project"],
  },
  {
    label: "PROJECT / META",
    blurb: "Orient yourself, read connectors, generate a typed client, set locales, send feedback.",
    tools: [
      "get_project_info",
      "list_connectors",
      "get_client_code",
      "set_locales",
      "send_feedback",
      "reset_project",
    ],
  },
];

/** Every tool named by the registry. The suite compares this to the live surface. */
export const GROUPED_TOOL_NAMES: string[] = TOOL_GROUPS.flatMap((g) => g.tools);
