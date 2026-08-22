import { ERROR_CODES } from "./error-codes";
import {
  MCP_TOOL_COUNT,
  FIELD_PRIMITIVE_COUNT,
  DELIVERY_REQUESTS_PER_WINDOW,
  MCP_CALLS_PER_WINDOW,
  IMAGE_TRANSFORMS_PER_WINDOW_PER_IP,
  RATE_WINDOW_MS,
  DELIVERY_ENDPOINTS,
  DEFINITION_CACHE_SECONDS,
  EDGE_CACHE_SECONDS,
  EDGE_STALE_WHILE_REVALIDATE_SECONDS,
} from "./platform-facts";

/**
 * The PUBLIC documentation surface — what an agent or a human can fetch by URL.
 *
 * WHY AN EXPLICIT ALLOWLIST, NOT A PATH PARAMETER. `docs/` also holds internal
 * plans, point-in-time reviews and PM state. Mapping a slug onto the filesystem
 * would make every one of those reachable by guessing a name. Publishing is a
 * decision taken per document, here, in code.
 *
 * WHY SOME DOCS ARE GENERATED. The limits and error-code references are derived
 * from `lib/platform-facts.ts` and `lib/error-codes.ts` at request time, so they
 * cannot drift from the values the platform actually enforces. That is the same
 * rule CP1 applied to the marketing site: a number that appears in public is
 * imported, never typed. A hand-written limits page would be wrong within a
 * sprint — this one is wrong only if the code is.
 */

export interface PublicDoc {
  /** Short human title, shown in the discovery index. */
  title: string;
  /** One line on what it is and who it is for. */
  description: string;
  /** Repo-relative file to serve, OR a generator. Exactly one. */
  file?: string;
  generate?: () => string;
  contentType: string;
}

const seconds = Math.round(RATE_WINDOW_MS / 1000);

/** The limits reference — every figure imported, none typed. */
export function renderLimits(): string {
  return `# Pluggie — limits

*Generated from the running platform. These are the values enforced in code, not
a description of them.*

## Rate limits

| Surface | Budget | Keyed on | Applies to |
| --- | --- | --- | --- |
| MCP \`/api/mcp\` | ${MCP_CALLS_PER_WINDOW} per ${seconds}s | the **project** — IP-independent | every call |
| Delivery \`/api/v1\` | ${DELIVERY_REQUESTS_PER_WINDOW} per ${seconds}s | the project **and** the client IP | writes, uploads, batch, checkout, and \`?q=\` search |
| Derived images | ${IMAGE_TRANSFORMS_PER_WINDOW_PER_IP} per ${seconds}s | the client IP | generating a new size; cached derivatives are free |

**Plain reads are not rate limited.** \`GET /api/v1/{collection}\` and
\`GET /api/v1/{collection}/{id}\` have no budget — only mutations and the
CPU-bound search path do.

Two consequences worth designing around:

- Delivery limits are per **(project, IP)**, so one caller cannot exhaust
  another's budget — but callers sharing a NAT (an office, a venue's wifi)
  share one bucket.
- A request that fails validation still consumes budget. A broken integration
  therefore throttles itself.

Exceeding a limit returns \`429\` with a \`retry-after\` header and the
\`E_RATE_LIMITED\` code.

## Convergence

Two different caches, and conflating them is the usual source of confusion:

| Layer | Window | Governs |
| --- | --- | --- |
| Collection definition | ~${DEFINITION_CACHE_SECONDS}s | a **schema** change becoming visible |
| Edge cache | ~${EDGE_CACHE_SECONDS}s (+ up to ${EDGE_STALE_WHILE_REVALIDATE_SECONDS}s stale-while-revalidate) | a cacheable delivery \`GET\` refreshing |

Entry **content** is not application-cached. An MCP read sees a write
immediately; a cacheable public GET can lag by the edge window above. If you are
building a live preview, read back over MCP rather than over the delivery API.

## Shape

- ${MCP_TOOL_COUNT} MCP tools
- ${FIELD_PRIMITIVE_COUNT} field primitives
- ${DELIVERY_ENDPOINTS} delivery endpoints under \`/api/v1\`
`;
}

/** The error-code reference — straight from the append-only registry. */
export function renderErrors(): string {
  const rows = Object.entries(ERROR_CODES)
    .map(([code, meaning]) => `| \`${code}\` | ${meaning} |`)
    .join("\n");
  return `# Pluggie — error codes

*Generated from the platform's append-only code registry.*

Every error is \`{ error, code }\`. The \`code\` is stable and safe to branch on;
the \`error\` message is human-readable and may change. Validation failures also
carry \`issues[]\` with a field, the constraint that failed, and a fix hint.

| Code | Meaning |
| --- | --- |
${rows}

Codes are **append-only** — an existing code never changes meaning, so a client
that branches on one keeps working.
`;
}

/** The registry. Adding a key here is the act of publishing. */
export const PUBLIC_DOCS: Record<string, PublicDoc> = {
  hooks: {
    title: "Before-write hooks",
    description: "The tenant-facing contract for validating or transforming a write before it lands.",
    file: "docs/hooks.md",
    contentType: "text/markdown; charset=utf-8",
  },
  capabilities: {
    title: "Capabilities",
    description: "What the platform can do today, grouped by surface.",
    file: "docs/CAPABILITIES.md",
    contentType: "text/markdown; charset=utf-8",
  },
  contract: {
    title: "MCP tool contract",
    description: `All ${MCP_TOOL_COUNT} MCP tools with their descriptions and input schemas, as markdown.`,
    file: "docs/ai-contract.md",
    contentType: "text/markdown; charset=utf-8",
  },
  "contract.json": {
    title: "MCP tool contract (JSON)",
    description: "The same contract as machine-readable JSON — tools plus the error-code registry.",
    file: "docs/ai-contract.json",
    contentType: "application/json; charset=utf-8",
  },
  limits: {
    title: "Limits",
    description: "Rate limits, cache convergence windows, and platform shape. Generated from the enforced values.",
    generate: renderLimits,
    contentType: "text/markdown; charset=utf-8",
  },
  errors: {
    title: "Error codes",
    description: "Every E_* code and what it means. Generated from the registry.",
    generate: renderErrors,
    contentType: "text/markdown; charset=utf-8",
  },
};

/**
 * The discovery index served at `/llms.txt`.
 *
 * An agent told to "read the docs" has to be able to find them without guessing
 * slugs — before this, the only fetchable document was the hooks reference, and
 * nothing announced even that.
 */
export function llmsTxt(base: string): string {
  const b = base.replace(/\/$/, "");
  const lines = Object.entries(PUBLIC_DOCS).map(
    ([slug, d]) => `- [${d.title}](${b}/api/docs/${slug}): ${d.description}`,
  );
  return `# Pluggie

> An MCP-native backend platform. An agent defines the data model over MCP and
> the platform produces a branded admin and a delivery API — no per-project
> backend code. ${MCP_TOOL_COUNT} tools, ${FIELD_PRIMITIVE_COUNT} field primitives.

## Start here

- MCP endpoint: \`${b}/api/mcp\` — stateless JSON-RPC, no initialize handshake required
- Delivery API base: \`${b}/api/v1\` — token-gated, serves only fields marked publicRead
- Call \`get_project_info\` first: it returns every URL for a project plus a routing table from common questions to answers

## Documentation

${lines.join("\n")}

## Notes

- Errors are \`{ error, code }\` with stable \`E_*\` codes; validation failures add \`issues[]\` with fix hints.
- Destructive schema changes return a plan and require \`confirm: true\` rather than applying.
- Plain delivery reads are not rate limited; writes and search are. See the limits reference.
`;
}
