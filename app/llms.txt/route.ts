import { NextRequest, NextResponse } from "next/server";
import { llmsTxt } from "@/lib/public-docs";
import { originFromHeaders } from "@/lib/origin";

/**
 * `/llms.txt` — the discovery index for an agent told to "read the docs".
 *
 * Without it the only way to find a reference was to already know its slug, and
 * the only published document was the hooks contract. This lists every public
 * doc with a one-line description, plus the two endpoints worth knowing first.
 *
 * The base URL is derived from the request rather than hard-coded, so the file
 * is correct on any host the platform answers on.
 */
export async function GET(req: NextRequest) {
  // originFromHeaders takes a getter and prefers APP_URL; fall back to the
  // request's own origin so the file is right even before APP_URL is set.
  const base = originFromHeaders((n) => req.headers.get(n)) ?? new URL(req.url).origin;
  return new NextResponse(llmsTxt(base), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
