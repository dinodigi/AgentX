import { TOOL_DEFS } from "./mcp/tools";

/**
 * DX-2 — the contract, rendered from the live tool registry.
 *
 * One renderer, two consumers: the `scripts/dump-contract.ts` snapshot (a repo
 * artifact for review diffs) and the PUBLIC `/api/contract` endpoint. The
 * endpoint exists because a copied contract drifts: the `docs/xvibe-brief/`
 * snapshot froze pre-CP5 semantics ("access.write REPLACES the anonymous
 * path") while the live platform composed them — and an integrator built
 * against the stale copy and planned for the wrong behavior (wall `15e5783b`).
 * Serving the rendering FROM `TOOL_DEFS` at request time makes that class of
 * bug structurally impossible: there is nothing to forget to regenerate.
 */

export function contractMarkdown(): string {
  let md = "# The AI contract — what an agent reads over MCP\n\n";
  md +=
    "> Rendered live from the tool registry — this document cannot drift from the " +
    "running platform. JSON form: `/api/contract?format=json`.\n\n";
  md += `This is the exact payload of the MCP **\`tools/list\`** call: **${TOOL_DEFS.length} tools**, each with a name, a description, and a JSON input schema. An agent connecting to a project reads this plus the runtime **\`get_project_info\`** orientation blob (URLs, boundaries, delivery-API reference) — those two are the whole surface it plans against.\n\n`;
  md += "## Tool index\n\n";
  for (const t of TOOL_DEFS) md += `- \`${t.name}\`\n`;
  md += "\n---\n\n";
  for (const t of TOOL_DEFS) {
    md += `## \`${t.name}\`\n\n`;
    md += `${t.description}\n\n`;
    md += "**Input schema:**\n\n```json\n" + JSON.stringify(t.inputSchema, null, 2) + "\n```\n\n";
  }
  return md;
}

/** The verbatim JSON-RPC `tools/list` result shape. */
export function contractJson(): { tools: typeof TOOL_DEFS } {
  return { tools: TOOL_DEFS };
}
