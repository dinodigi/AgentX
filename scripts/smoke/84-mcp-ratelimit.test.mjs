import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, createEphemeralProject, sql } from "./helpers.mjs";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";

// Hatchly feedback: the MCP throttle response used to be unstructured prose
// ("rate limit exceeded — slow down and retry") — no E_ code, no retry hint —
// so clients regex-matched the message to tell throttling from real failures.
// Now it must carry the same contract as every other error: [E_RATE_LIMITED]
// in the message, machine-readable error.data {code, retryAfterSec}, and a
// Retry-After header.
describe("MCP rate limit is a structured error", () => {
  let p;
  before(async () => {
    await ensureServer();
    p = await createEphemeralProject("mcp-ratelimit");
  });
  after(() => p.destroy());

  it("a call past the ceiling yields E_RATE_LIMITED with a retry hint", async () => {
    // Deterministic trip: pre-fill the limiter's durable window rows at the
    // ceiling (current + next window, so a rollover mid-test can't race us),
    // then ONE real request goes over — exercising the exact production path
    // without hammering 300 HTTP calls through a dev server.
    const WINDOW_MS = 60_000;
    for (const offset of [0, 1]) {
      const windowStart = new Date((Math.floor(Date.now() / WINDOW_MS) + offset) * WINDOW_MS);
      await sql`
        INSERT INTO rate_windows (key, window_start, project_id, count)
        VALUES (${"mcp:" + p.id}, ${windowStart.toISOString()}, ${p.id}, 300)
        ON CONFLICT (key, window_start) DO UPDATE SET count = 300`;
    }

    const res = await fetch(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.mcpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    const limited = { headers: res.headers, body: await res.json().catch(() => null) };
    assert.ok(limited.body?.error, `over-ceiling call must be limited: ${JSON.stringify(limited.body)}`);

    const err = limited.body.error;
    assert.match(err.message, /\[E_RATE_LIMITED\]/, `message carries the code: ${err.message}`);
    assert.match(err.message, /retry after \d+s/i, "message names the wait");
    assert.equal(err.data?.code, "E_RATE_LIMITED", "error.data.code is machine-readable");
    assert.ok(Number.isFinite(err.data?.retryAfterSec) && err.data.retryAfterSec >= 1, "retryAfterSec present");
    assert.equal(err.data?.limit, 300);
    assert.ok(limited.headers.get("retry-after"), "Retry-After header set");
  });
});
