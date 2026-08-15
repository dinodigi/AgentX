/**
 * The rate limiter's caller identity — one implementation, eight call sites.
 *
 * WHY THIS FILE EXISTS. Every rate-limited route used to key its budget on
 * `x-forwarded-for.split(",")[0]` — the LEFTMOST entry of a header the caller
 * supplies. That is attacker-controlled: rotating it mints an unlimited supply
 * of fresh buckets (defeating the limiter entirely), and setting it to someone
 * else's address burns THEIR budget.
 *
 * This was already known and written down. `app/(marketing)/actions.ts` carries
 * the decision verbatim:
 *
 *   "We also do NOT echo the visitor's X-Forwarded-For (its leftmost entry is
 *    client-controlled, so forwarding it would let a script rotate spoofed IPs
 *    to defeat the delivery rate limiter)."
 *
 * A later change to fix a shared-bucket problem started forwarding it anyway,
 * which is how a documented security decision got quietly reverted. This file
 * is the single place that decision now lives.
 *
 * THE ORDER, and why:
 *
 *  1. `cf-connecting-ip` — Cloudflare OVERWRITES this on every request it
 *     proxies, so a client cannot forge it through the edge. This is the
 *     authoritative source in production, which sits behind Cloudflare.
 *  2. `x-forwarded-for` LAST entry — the entry appended by the nearest proxy,
 *     rather than the first, which is whatever the client typed. Strictly
 *     harder to forge than the leftmost, and it degrades toward "everyone
 *     shares a bucket" rather than "everyone gets their own", which is the
 *     safe direction for a brake.
 *  3. `"local"` — no proxy headers at all (local dev, internal server-to-server
 *     calls). A single shared bucket, which fails safe.
 *
 * RESIDUAL RISK, stated rather than hidden: (1) and (2) are only untamperable
 * for traffic that actually arrives through Cloudflare. A request sent straight
 * to the origin host can set either header freely. Closing that completely is a
 * deployment concern — restrict origin access to Cloudflare — not something
 * this function can do. It is recorded on the backlog rather than implied fixed.
 */

/** Headers that carry a caller address, in decreasing order of trustworthiness. */
export function clientIp(headers: Headers): string {
  // Cloudflare's own header. Overwritten at the edge, so it cannot be forged
  // by a client whose request passes through it.
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  // Fall back to the LAST forwarded entry — appended by the closest proxy —
  // never the first, which is caller-supplied.
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }

  // No proxy in front: local dev, or an internal server-to-server call. One
  // shared bucket is the safe default — it over-limits rather than under-limits.
  return "local";
}
