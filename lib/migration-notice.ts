/**
 * Host migration notice — the temporary machinery for moving the platform to a
 * new domain without breaking anyone.
 *
 * DESIGN RULE: silent unless configured. `SUCCESSOR_API_BASE` is unset in normal
 * operation and every function here returns null, so nothing appears in tool
 * results or HTTP headers. A migration notice pointing at a host that does not
 * resolve yet would be worse than no notice at all — integrators would chase an
 * instruction they cannot follow.
 *
 * When the new host is live, set the env var and the notice appears in two
 * places at once:
 *   - `get_project_info` (agents read this; they are the primary integrator here)
 *   - every delivery response, as RFC 8594 headers
 *
 * WHY NOT A REDIRECT: a 301 breaks POST bodies in several HTTP clients and
 * drops Authorization headers across origins — a silent auth failure during a
 * migration is the worst possible failure mode. The old host keeps answering
 * normally and merely says where the new one is.
 *
 * The old host does NOT have to be retired afterwards. Keeping it alive is one
 * DNS record and one certificate, and it is what makes the OAuth cost vanish:
 * connected MCP clients never re-authorize, because their resource identifier
 * never changes.
 */

/** Configured successor origin, or null when no migration is in progress. */
export function successorBase(): string | null {
  const raw = process.env.SUCCESSOR_API_BASE?.trim();
  if (!raw) return null;
  try {
    // Must be an absolute origin. A malformed value stays SILENT rather than
    // emitting a broken instruction — the whole point of this module.
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Optional sunset date (ISO). Absent = deprecated but no end date announced. */
function sunsetDate(): Date | null {
  const raw = process.env.SUCCESSOR_SUNSET?.trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * RFC 8594 deprecation headers for a delivery response. Empty object when no
 * migration is configured, so this can be spread unconditionally.
 */
export function migrationHeaders(currentUrl?: string): Record<string, string> {
  const base = successorBase();
  if (!base) return {};
  const headers: Record<string, string> = {
    deprecation: "true",
    // 299 is the "miscellaneous persistent warning" code — the right one for a
    // notice that is not tied to a transformation.
    warning: `299 - "this host is deprecated; move to ${base}"`,
  };
  const sunset = sunsetDate();
  if (sunset) headers.sunset = sunset.toUTCString();
  if (currentUrl) {
    try {
      const u = new URL(currentUrl);
      headers.link = `<${base}${u.pathname}${u.search}>; rel="successor-version"`;
    } catch {
      /* a URL we cannot parse simply gets no Link header */
    }
  }
  return headers;
}

/**
 * The agent-facing note for `get_project_info`. Null when no migration is
 * configured, so the caller omits the key entirely rather than shipping an
 * empty field that reads as "something is wrong here".
 */
export function migrationNotice(currentBase: string): string | null {
  const base = successorBase();
  if (!base) return null;
  const sunset = sunsetDate();
  return (
    `HOST MIGRATION IN PROGRESS. This project is reachable at ${currentBase}, but that host is ` +
    `DEPRECATED — the new base is ${base}. Nothing is broken and no call will start failing: the ` +
    `old host keeps answering normally${sunset ? ` until at least ${sunset.toISOString().slice(0, 10)}` : ""}. ` +
    `TO MOVE: the generated client already accepts a base URL, so pass ` +
    `createClient({ baseUrl: "${base}/api/v1" }) (or set the env var your app reads) and redeploy — ` +
    `no code change beyond that line. Responses from the old host also carry RFC 8594 ` +
    `Deprecation/Sunset/Link headers if you prefer to detect this programmatically.`
  );
}
