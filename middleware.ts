import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Clerk gate. The admin dashboard requires a signed-in operator/client. The
 * MCP endpoint, the public delivery API, and the CRON_SECRET-authed job drain
 * authenticate by their own tokens, so they are excluded from the Clerk gate.
 */
const isProtected = createRouteMatcher(["/admin(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  matcher: [
    // Run on everything except static assets and the token-authed API routes.
    "/((?!_next|api/mcp|api/v1|api/jobs|.*\\.(?:ico|png|jpg|jpeg|svg|css|js)$).*)",
  ],
};
