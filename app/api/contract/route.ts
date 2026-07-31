import { NextRequest, NextResponse } from "next/server";
import { contractMarkdown, contractJson } from "@/lib/contract-doc";

/**
 * DX-2 — the PUBLIC contract endpoint. No auth: this is the same information
 * `tools/list` hands any MCP token, minus anything project-specific, and its
 * whole purpose is to be quotable by URL (client system prompts, briefs,
 * onboarding docs) instead of copied into files that drift.
 *
 * Rendered per instance from the live TOOL_DEFS (module-level — the registry is
 * code, so it can only change on deploy) and served with a short edge TTL so a
 * deploy propagates on the same ~cache horizon as the rest of the platform.
 */

const md = contractMarkdown();
const json = JSON.stringify(contractJson(), null, 2);

export async function GET(req: NextRequest) {
  const format = new URL(req.url).searchParams.get("format");
  const body = format === "json" ? json : md;
  return new NextResponse(body, {
    headers: {
      "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      // Edge-cacheable, same convergence story as delivery reads (~15s note).
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
