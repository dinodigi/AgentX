import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DX-2 — public reference docs by URL. The contract used to say "full
 * reference: docs/hooks.md in the AgentX repo", which an API consumer cannot
 * fetch — a self-containment violation (an agent reading the contract over MCP
 * has no repo). Served from an explicit ALLOWLIST, not a path parameter mapped
 * to the filesystem: `docs/` also holds internal plans, reviews and PM state
 * that must never become reachable by guessing a slug.
 */
const DOCS: Record<string, string> = {
  hooks: "docs/hooks.md",
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const file = DOCS[doc];
  if (!file) {
    return NextResponse.json(
      { error: `unknown doc "${doc}" — available: ${Object.keys(DOCS).join(", ")}`, code: "E_NOT_FOUND" },
      { status: 404 },
    );
  }
  let body: string;
  try {
    body = readFileSync(join(process.cwd(), file), "utf8");
  } catch {
    return NextResponse.json({ error: "doc unavailable on this deployment", code: "E_INTERNAL" }, { status: 500 });
  }
  return new NextResponse(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
