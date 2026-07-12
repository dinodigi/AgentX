import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { ensureServer, createEphemeralProject, mcp, BASE } from "./helpers.mjs";

/**
 * C2: the durable rate-limit store. The brake must actually brake through the
 * HTTP surface, the counters must live in Postgres (shared across instances /
 * restarts — the launch requirement), and the drain's rollup must fold expired
 * windows into per-project daily usage.
 */
const sql = neon(process.env.DATABASE_URL);
const SECRET = process.env.CRON_SECRET;

// A synthetic client IP per run keeps window keys isolated from other suites.
const IP = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

describe("rate limit: durable pg store (C2)", () => {
  let p;
  before(async () => {
    await ensureServer();
    if (!SECRET || SECRET.length < 16) {
      throw new Error("CRON_SECRET (>=16 chars) must be set in .env for the drain tests");
    }
    p = await createEphemeralProject("ratelimit");
    const r = await mcp(p.mcpToken, "define_collection", {
      name: "leads",
      publicWrite: true,
      fields: [{ name: "email", label: "Email", type: "text", required: true }],
    });
    assert.equal(r.ok, true, r.errorText);
  });
  after(async () => {
    await p.destroy();
  });

  it("a burst over the window limit 429s, and the counter is a durable pg row", async () => {
    // Fixed windows are minute-aligned; if the minute is nearly over, start
    // cleanly inside the next one so the whole burst lands in ONE window.
    const secondsIn = (Date.now() / 1000) % 60;
    if (secondsIn > 40) await new Promise((res) => setTimeout(res, (61 - secondsIn) * 1000));

    const burst = 25; // limit is 20/min/ip
    const results = await Promise.all(
      Array.from({ length: burst }, (_, i) =>
        fetch(`${BASE}/api/v1/leads`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${p.deliveryToken}`,
            "content-type": "application/json",
            "x-forwarded-for": IP,
          },
          body: JSON.stringify({ email: `burst${i}@x.test` }),
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    const limited = results.filter((r) => r.status === 429);
    assert.equal(ok.length, 20, `exactly the window budget should pass (got ${ok.length})`);
    assert.equal(limited.length, 5, `the excess should 429 (got ${limited.length})`);
    const retryAfter = Number(limited[0].headers.get("retry-after"));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `retry-after should point at the window end (got ${retryAfter})`);

    // Durability: the count is a Postgres row written by the SERVER process
    // and readable here — not process memory.
    const rows = await sql`SELECT count, project_id FROM rate_windows WHERE key = ${`${p.id}:${IP}`}`;
    const total = rows.reduce((s, r) => s + r.count, 0);
    assert.equal(total, burst, "every hit lands in the shared store");
    assert.equal(rows[0].project_id, p.id, "hits are attributed for metering");
  });

  it("the drain rolls expired windows into usage_daily and drops them", async () => {
    const old = new Date(Date.now() - 5 * 60_000);
    const day = old.toISOString().slice(0, 10);
    await sql`INSERT INTO rate_windows (key, window_start, project_id, count)
      VALUES (${`${p.id}:rollup-probe`}, ${old.toISOString()}, ${p.id}, 7),
             ('img:unattributed-probe', ${old.toISOString()}, NULL, 3)`;

    const res = await fetch(`${BASE}/api/jobs/drain`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok("rolledUp" in body, "the drain reports the rollup");

    const [daily] = await sql`SELECT count FROM usage_daily WHERE project_id = ${p.id} AND day = ${day}`;
    assert.ok(daily && daily.count >= 7, `expired attributed windows accumulate (got ${daily?.count})`);
    const leftovers = await sql`SELECT 1 FROM rate_windows
      WHERE key IN (${`${p.id}:rollup-probe`}, 'img:unattributed-probe')`;
    assert.equal(leftovers.length, 0, "expired windows are deleted, attributed or not");
  });
});
