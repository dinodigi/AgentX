import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for tenant-controlled outbound targets (C4). Webhooks, write
 * hooks, event actions, and schedule fires all POST to tenant-supplied URLs
 * from OUR network, and the delivery log echoes status codes back — without a
 * guard that's a blind port-scanner into whatever the host can reach
 * (loopback, link-local metadata, private ranges).
 *
 * Enforcement is fire-time (URLs are stored freely; DNS changes between save
 * and fire anyway) and PRODUCTION-only: local dev and the smoke suite point
 * webhooks at 127.0.0.1 receivers by design. ALLOW_PRIVATE_WEBHOOK_TARGETS=1
 * is the operator escape hatch. Residual risk accepted for launch: DNS
 * rebinding between our lookup and fetch's own resolution — the standard
 * mitigation (pinned-IP dispatcher) needs an undici-level hook; recorded in
 * the C4 notes.
 */

const REFUSAL =
  "webhook target is not reachable from the platform (private, loopback, or link-local address) — use a public endpoint";

function ipIsPrivate(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + reserved
    );
  }
  const v6 = v4.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fe80:") ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("ff")
  );
}

function guardActive(): boolean {
  return process.env.NODE_ENV === "production" && process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS !== "1";
}

/** Sync shape check for SAVE paths: protocol + no embedded credentials. */
export function webhookUrlShapeRefusal(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "invalid URL";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "webhook URLs must be http(s)";
  if (u.username || u.password) return "credentials embedded in webhook URLs are not allowed";
  return null;
}

/** Full fire-time check: shape + (in production) hostname/IP range validation. */
export async function webhookTargetRefusal(rawUrl: string): Promise<string | null> {
  const shape = webhookUrlShapeRefusal(rawUrl);
  if (shape) return shape;
  if (!guardActive()) return null;

  const hostRaw = new URL(rawUrl).hostname;
  const host = hostRaw.replace(/^\[|\]$/g, ""); // URL keeps brackets on IPv6
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return REFUSAL;
  }
  if (isIP(host)) return ipIsPrivate(host) ? REFUSAL : null;
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    if (addrs.length === 0) return "webhook host does not resolve";
    if (addrs.some((a) => ipIsPrivate(a.address))) return REFUSAL;
  } catch {
    return "webhook host does not resolve";
  }
  return null;
}
