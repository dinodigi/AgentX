/**
 * MT-1 / D2 — scoped MCP tokens.
 *
 * Deliberately NOT `server-only`: this module is pure constants and pure
 * functions — no secrets, no DB, no request state. D3's consent screen will
 * render `MCP_SCOPES` descriptions in the browser, and the completeness test
 * imports it directly. Enforcement lives in callTool; this file only describes.
 *
 * WHY COARSE: these names are read aloud by a consent screen (D3/OAuth). A
 * scope nobody can explain in one line is a scope nobody can consent to, so the
 * vocabulary is deliberately six buckets rather than per-tool permissions.
 *
 * WHY ONE SCOPE PER TOOL: compound requirements ("needs content.read AND
 * schema.manage") double the mental model for marginal precision. Where a tool
 * spans two areas, it files under the SENSITIVE one — `export_project` reads
 * schema and content, and lands in `content.read` because content is what
 * matters if it leaks.
 *
 * READS vs WRITES: every read that does not return entry content lives in
 * `observability.read` — including schema reads. A content-only token must be
 * able to ORIENT (list_collections, describe_collection) or it cannot function,
 * and forcing `schema.manage` for that would make every token a schema-mutating
 * token, defeating the point.
 *
 * GRANDFATHERING: `project_tokens.scopes = null` means FULL ACCESS. Every
 * token minted before this shipped is null, so enforcement is inert for them
 * and nothing breaks on deploy.
 */

export const MCP_SCOPES = {
  "content.read": "read this project's content",
  "content.write": "create, edit, and delete content",
  "schema.manage": "change the content model",
  "automation.manage": "manage automations",
  "tokens.manage": "issue and revoke site credentials",
  "observability.read": "see logs, schema, and project info",
} as const;

export type McpScope = keyof typeof MCP_SCOPES;

export const ALL_SCOPES = Object.keys(MCP_SCOPES) as McpScope[];

/**
 * The default set an OAuth consent screen pre-checks: enough to build an app,
 * without the two that deserve a deliberate opt-in. `automation.manage` can
 * schedule recurring mutations; `tokens.manage` can issue credentials — both
 * are things a user should choose, not inherit.
 */
export const DEFAULT_CONSENT_SCOPES: McpScope[] = [
  "content.read",
  "content.write",
  "schema.manage",
  "observability.read",
];

/**
 * Tools that need NO scope. `send_feedback` is deliberately always available:
 * the feedback wall must hear from any token, including one so narrowly scoped
 * that it cannot do anything else. Silencing the complaint channel for
 * restricted tokens would hide exactly the friction worth knowing about.
 */
export const UNSCOPED_TOOLS = new Set(["send_feedback"]);

/** Every MCP tool → the single scope that authorizes it. */
export const TOOL_SCOPE: Record<string, McpScope> = {
  // ── observability.read — orientation, logs, and SCHEMA READS ────────────
  get_project_info: "observability.read",
  list_connectors: "observability.read",
  list_field_types: "observability.read",
  list_collections: "observability.read",
  describe_collection: "observability.read",
  list_blocks: "observability.read",
  list_plugins: "observability.read",
  get_plugin: "observability.read",
  get_client_code: "observability.read",
  get_deliveries: "observability.read",
  get_audit_log: "observability.read",
  list_jobs: "observability.read",
  list_schedules: "observability.read",
  // SEO advisors (already plugin-gated): read-only, and they touch external
  // pages rather than project data.
  fetch_page: "observability.read",
  score_page: "observability.read",
  audit_site: "observability.read",

  // ── content.read — anything returning entry content ─────────────────────
  query_entries: "content.read",
  get_entry: "content.read",
  search_entries: "content.read",
  count_entries: "content.read",
  aggregate_entries: "content.read",
  get_changes: "content.read",
  export_entries: "content.read",
  export_project: "content.read", // schema + content; files under the sensitive half
  list_assets: "content.read",
  list_trash: "content.read",
  list_entry_versions: "content.read",

  // ── content.write — creates, edits, AND DELETES (incl. irreversible) ────
  create_entry: "content.write",
  update_entry: "content.write",
  update_entry_if: "content.write",
  delete_entry: "content.write",
  bulk_create_entries: "content.write",
  transact: "content.write",
  restore_entry: "content.write",
  purge_entry: "content.write", // irreversible — hence the consent line says "delete"
  empty_trash: "content.write", // irreversible
  restore_entry_version: "content.write",
  upload_asset: "content.write",
  delete_asset: "content.write",

  // ── schema.manage — mutations to the content model ──────────────────────
  define_collection: "schema.manage",
  delete_collection: "schema.manage",
  reset_project: "schema.manage",
  define_block: "schema.manage",
  delete_block: "schema.manage",
  set_locales: "schema.manage",
  enable_plugin: "schema.manage",
  disable_plugin: "schema.manage",
  define_plugin: "schema.manage",
  delete_plugin: "schema.manage",
  // import_project CREATES COLLECTIONS — it is a schema mutation wearing a
  // content coat. Filing it under content.write would be silent privilege
  // escalation for a content-scoped token.
  import_project: "schema.manage",

  // ── automation.manage — background behavior ─────────────────────────────
  define_schedule: "automation.manage",
  delete_schedule: "automation.manage",
  cancel_job: "automation.manage",
  configure_inbound: "automation.manage",
  disable_inbound: "automation.manage",
  test_hook: "automation.manage", // makes an outbound call to a tenant endpoint
  refire_delivery: "automation.manage",

  // ── tokens.manage — credential issuance ─────────────────────────────────
  mint_delivery_token: "tokens.manage",
  list_delivery_tokens: "tokens.manage",
  revoke_delivery_token: "tokens.manage",
};

/** Names in `scopes` that are not real scopes (typo, stale, or hand-edited). */
export function unknownScopes(scopes: string[]): string[] {
  return scopes.filter((s) => !(s in MCP_SCOPES));
}

export interface ScopeCheck {
  allowed: boolean;
  /** The scope this tool needed — for the refusal message. */
  needed?: McpScope;
}

/**
 * The single authorization decision, called once at the top of callTool.
 *
 * `granted === null` is the GRANDFATHER path: a pre-scopes token, full access.
 * An unknown tool name returns allowed:true so dispatch can answer its own
 * E_UNKNOWN_TOOL — a scope error would be a misleading diagnosis.
 */
export function checkToolScope(toolName: string, granted: string[] | null): ScopeCheck {
  if (granted === null) return { allowed: true };
  if (UNSCOPED_TOOLS.has(toolName)) return { allowed: true };
  const needed = TOOL_SCOPE[toolName];
  if (!needed) return { allowed: true };
  return granted.includes(needed) ? { allowed: true } : { allowed: false, needed };
}

/**
 * SUBSET RULE — extends TOK-1's "a mint is strictly weaker than its minter"
 * from scope-KIND to scope-SET. A token may never issue one broader than
 * itself, or scoping would be a suggestion rather than a boundary.
 * A full-access (null) token may grant anything.
 */
export function isSubsetOf(requested: string[], granted: string[] | null): boolean {
  if (granted === null) return true;
  return requested.every((s) => granted.includes(s));
}
