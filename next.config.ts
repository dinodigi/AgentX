import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@modelcontextprotocol/sdk", "ws", "sharp"],
  /**
   * DX-6: the OAuth discovery documents MUST live at their literal
   * `/.well-known/...` paths (RFC 8414 / RFC 9728). The App Router will not
   * route a dot-prefixed directory, so the handlers live under /api and are
   * rewritten here — clearer than fighting the router with escapes.
   */
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/well-known/oauth-protected-resource",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/well-known/oauth-authorization-server",
      },
      // Some clients probe the resource-specific form (RFC 9728 §3.1).
      {
        source: "/.well-known/oauth-protected-resource/api/mcp",
        destination: "/api/well-known/oauth-protected-resource",
      },
      {
        source: "/.well-known/oauth-authorization-server/api/mcp",
        destination: "/api/well-known/oauth-authorization-server",
      },
    ];
  },
  async headers() {
    return [
      {
        // Admin + non-delivery routes. Strict CSP deferred: Clerk + Next
        // inline scripts need a careful allowlist (docs/subsystems/02).
        source: "/((?!api/v1).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "/api/v1/:path*",
        headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
      },
    ];
  },
};

export default nextConfig;
