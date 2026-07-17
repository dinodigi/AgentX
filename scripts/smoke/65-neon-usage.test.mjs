import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ensureServer, BASE, sql } from "./helpers.mjs";

// Track 4b: the drain carries a self-throttled per-project Neon consumption
// sweep (managed planes only). With a real NEON_API_KEY + managed connectors
// in the DB the first unthrottled drain captures real rows; either way the
// wiring must report a number and the ~6h throttle must hold on a re-drain.
describe("neon usage snapshot (Track 4b)", () => {
  before(async () => {
    await ensureServer();
  });

  const drain = () =>
    fetch(`${BASE}/api/jobs/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });

  it("drain reports the sweep and the throttle holds on an immediate re-drain", async () => {
    const r1 = await drain();
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(typeof b1.neonUsage, "number", JSON.stringify(b1));

    const r2 = await drain();
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.equal(b2.neonUsage, 0, "second sweep within the interval must be throttled");
  });

  it("captured snapshots (if any) are sane per-project rows", async () => {
    const rows = await sql`SELECT * FROM neon_usage_daily`;
    for (const r of rows) {
      assert.ok(r.project_id);
      assert.ok(Number(r.compute_time_seconds) >= 0);
      assert.ok(Number(r.synthetic_storage_size_bytes) >= 0);
      assert.ok(r.captured_at);
    }
  });
});
