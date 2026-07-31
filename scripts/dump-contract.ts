/**
 * Snapshot the contract to docs/ for release-diff review. The RENDERER lives in
 * lib/contract-doc.ts and is shared with the public /api/contract endpoint —
 * the endpoint is the consumer-facing truth (it cannot drift); this file is the
 * repo artifact you diff when tools.ts changes.
 *
 * Run:  npx tsx --conditions react-server scripts/dump-contract.ts
 * (--conditions react-server satisfies the `server-only` imports tools.ts pulls.)
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { TOOL_DEFS } from "../lib/mcp/tools";
import { contractMarkdown, contractJson } from "../lib/contract-doc";

writeFileSync("docs/ai-contract.json", JSON.stringify(contractJson(), null, 2));
writeFileSync("docs/ai-contract.md", contractMarkdown());
console.log(`Wrote ${TOOL_DEFS.length} tools → docs/ai-contract.md + docs/ai-contract.json`);
process.exit(0);
