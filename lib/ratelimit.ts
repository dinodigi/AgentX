/**
 * Sliding-window rate limiter for the public-write surface, behind a
 * one-method store interface. Default store is in-memory: exact on a single
 * instance (local/dev), per-lambda on serverless — still a real brake on
 * naive spam. At deploy time, swap `store` for a shared implementation
 * (Upstash/Neon) of the same interface; call sites don't change.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

export interface RateLimitStore {
  /** Atomically record a hit and report whether it fits inside the window. */
  hit(
    key: string,
    now: number,
    windowMs: number,
    max: number,
  ): Promise<{ allowed: boolean; oldestInWindow: number }>;
}

class MemoryStore implements RateLimitStore {
  private hits = new Map<string, number[]>();

  async hit(key: string, now: number, windowMs: number, max: number) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return { allowed: false, oldestInWindow: recent[0] };
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Opportunistic cleanup so the map can't grow unbounded.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.every((t) => now - t >= windowMs)) this.hits.delete(k);
      }
    }
    return { allowed: true, oldestInWindow: recent[0] };
  }
}

const store: RateLimitStore = new MemoryStore();

export async function rateLimit(
  key: string,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const now = Date.now();
  const res = await store.hit(key, now, WINDOW_MS, MAX_PER_WINDOW);
  if (res.allowed) return { allowed: true, retryAfterSec: 0 };
  return {
    allowed: false,
    retryAfterSec: Math.ceil((WINDOW_MS - (now - res.oldestInWindow)) / 1000),
  };
}
