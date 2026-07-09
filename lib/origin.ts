/**
 * The app's PUBLIC origin, derived from proxy-aware request headers. Behind a
 * proxy (Render, Netlify) the process is reached on an internal bind, so the
 * request URL's own origin is wrong for anything we hand back to callers (MCP
 * URLs, a registered Stripe webhook URL). Prefer an explicit APP_URL, then the
 * proxy's forwarded host, else the raw Host.
 *
 * `get` is a header accessor — `req.headers.get` (route) or `(await headers()).get`
 * (server action). `fallbackProto` covers the action case, which has no request
 * URL to read the scheme from (Render terminates TLS, so https is right there).
 */
export function originFromHeaders(
  get: (name: string) => string | null | undefined,
  fallbackProto = "https",
): string | null {
  const override = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (override) return override;
  const host = get("x-forwarded-host") ?? get("host");
  if (!host) return null;
  const proto = get("x-forwarded-proto") ?? fallbackProto;
  return `${proto}://${host}`;
}
