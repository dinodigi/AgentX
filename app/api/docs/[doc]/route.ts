import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_DOCS } from "@/lib/public-docs";

/**
 * DX-2 — public reference docs by URL. The contract used to say "full
 * reference: docs/hooks.md in the AgentX repo", which an API consumer cannot
 * fetch — a self-containment violation (an agent reading the contract over MCP
 * has no repo).
 *
 * Served from an explicit ALLOWLIST in lib/public-docs.ts, never a path
 * parameter mapped onto the filesystem: `docs/` also holds internal plans,
 * reviews and PM state that must never become reachable by guessing a slug.
 * Some entries are GENERATED from the platform's own constants so they cannot
 * drift from what the code enforces.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  const entry = PUBLIC_DOCS[doc];
  if (!entry) {
    return NextResponse.json(
      {
        error: `unknown doc "${doc}" — available: ${Object.keys(PUBLIC_DOCS).join(", ")}`,
        code: "E_NOT_FOUND",
      },
      { status: 404 },
    );
  }

  let body: string;
  if (entry.generate) {
    body = entry.generate();
  } else {
    try {
      body = readFileSync(join(process.cwd(), entry.file as string), "utf8");
    } catch {
      return NextResponse.json({ error: "doc unavailable on this deployment", code: "E_INTERNAL" }, { status: 500 });
    }
  }

  return new NextResponse(body, {
    headers: {
      "content-type": entry.contentType,
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
