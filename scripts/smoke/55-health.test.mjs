import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, BASE } from "./helpers.mjs";

/**
 * C5 health endpoint: public, uncached, DB-aware.
 *
 * OPS-3 (2026-07-22): the status code is LIVENESS and is now **always 200**;
 * readiness moved into the body (`status:"degraded"` / `db:"down"`). A 503 here
 * is what let the 2026-07-21 control-DB outage restart-loop every instance and
 * black out even static pages.
 *
 * This file can only prove the HAPPY path — it runs against a live dev server,
 * whose DB is up by definition. The degraded contract (200 + degraded body + no
 * "ok" keyword, so UptimeRobot still alerts) is verified by:
 *   npx tsx --conditions react-server --env-file=.env scripts/verify-health-degraded.mjs
 *
 * (The SSRF guard, C4, is production-gated and verified separately; it can't
 * fire against a dev server that legitimately targets 127.0.0.1 receivers.)
 */
describe("health endpoint (C5)", () => {
  before(ensureServer);

  it("GET /api/health → 200 ok, db up, no Clerk redirect", async () => {
    const res = await fetch(`${BASE}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.db, "up");
    assert.ok(typeof body.latencyMs === "number");
  });

  it("?deep proves it can actually query, not just connect", async () => {
    const res = await fetch(`${BASE}/api/health?deep`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deep, true);
    assert.equal(body.db, "up");
  });
});
