import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/db";
import { projectTokens } from "@/db/schema";

/**
 * Project tokens scope the single MCP server to one project. We store only a
 * hash; the raw token is shown once at creation time.
 */

const PREFIX = "agx_";

export function generateToken(): string {
  return PREFIX + randomBytes(24).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Resolve a raw bearer token to its project id, or null if unknown.
 * Cached cross-request (this runs on EVERY MCP and delivery call); revoking a
 * token must call revalidateTag("project-tokens").
 */
export async function resolveProjectId(rawToken: string): Promise<string | null> {
  if (!rawToken.startsWith(PREFIX)) return null;
  const hash = hashToken(rawToken);
  const cached = unstable_cache(
    async () => {
      const rows = await db
        .select({ projectId: projectTokens.projectId })
        .from(projectTokens)
        .where(eq(projectTokens.tokenHash, hash))
        .limit(1);
      return rows[0]?.projectId ?? null;
    },
    ["token", hash],
    { tags: ["project-tokens"] },
  );
  return cached();
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
