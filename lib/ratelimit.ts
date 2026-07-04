/**
 * Sliding-window rate limiter for the public-write surface. In-memory: exact
 * on a single instance (local/dev), per-lambda on serverless — still a real
 * brake on naive spam. Swap for a shared store (Upstash/Neon) if abuse
 * outgrows it; the call site won't change.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

const hits = new Map<string, number[]>();

export function rateLimit(key: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return { allowed: false, retryAfterSec: Math.ceil((WINDOW_MS - (now - recent[0])) / 1000) };
  }
  recent.push(now);
  hits.set(key, recent);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return { allowed: true, retryAfterSec: 0 };
}
