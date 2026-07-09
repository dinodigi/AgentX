/**
 * Stable machine-readable error codes for the MCP surface. Every tool error
 * reads `Error [CODE]: message` — agents branch on the code, humans (and
 * agents) repair from the message. Codes are append-only: never rename or
 * reuse one, or every client generated before the change mis-branches.
 */
export const ERROR_CODES = {
  E_VALIDATION:
    "input failed validation (tool arguments, field definitions, or entry data) — the message states the exact fix",
  E_NOT_FOUND:
    "referenced project/collection/entry/asset does not exist — list_collections / list_assets show what does",
  E_CONFIRM_REQUIRED:
    "destructive operation returned a plan instead of applying — re-run the same call with confirm: true",
  E_BLOCKED:
    "operation blocked by existing references — the message lists them; remove those first",
  E_CONNECTOR_REQUIRED:
    "a required connector is not connected — the operator connects it in project settings (not over MCP)",
  E_CONFLICT:
    "conditional update did not apply — the if-conditions (or a constraint guard) no longer match the row; re-read and retry",
  E_AUTH: "missing or invalid credentials — project token or X-User-Token",
  E_RATE_LIMITED: "too many requests — wait for the retry-after header, then retry",
  E_SCOPE: "the token lacks the required scope for this operation",
  E_UNKNOWN_TOOL: "no such tool — tools/list shows the full surface",
  E_INTERNAL: "unexpected server error — not agent-repairable; retry or report",
  E_UNCONFIGURED:
    "a required server env var is missing or too weak — the message names the exact var and constraint (operator-fixed, not agent-repairable)",
  E_UPSTREAM:
    "an external provider (e.g. Stripe) rejected the request — the message carries the provider's own reason; fix the referenced config or retry",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
