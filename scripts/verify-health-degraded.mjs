/**
 * OPS-3 verification — the DEGRADED path of /api/health.
 *
 * The smoke suite (`55-health.test.mjs`) can only assert the happy path: it
 * runs against a live dev server whose control DB is, by definition, up. This
 * script covers the case that actually matters by pointing the real route
 * handler at an unreachable database and asserting the contract Render and
 * UptimeRobot depend on:
 *
 *   HTTP 200  (liveness — keeps the instance in rotation; a 503 here is what
 *              turned the 2026-07-21 DB outage into a full-site blackout)
 *   body      {status:"degraded", db:"down", …}   (readiness lives in the body)
 *   no "ok"   anywhere in the body, so the UptimeRobot keyword monitor fires
 *
 * Run:
 *   npx tsx --conditions react-server --env-file=.env scripts/verify-health-degraded.mjs
 *
 * (`--conditions react-server` is required — the route imports server-only libs.
 * No dev server needed, and it never touches the real database.)
 */

// Must be set BEFORE the import: db/index.ts reads DATABASE_URL at module load.
process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:5599/unreachable";

const { GET } = await import("../app/api/health/route.ts");

let failures = 0;

for (const url of ["http://local/api/health", "http://local/api/health?deep"]) {
  const res = await GET(new Request(url));
  const body = await res.text();
  const problems = [];

  if (res.status !== 200) {
    problems.push(`expected HTTP 200 (liveness), got ${res.status} — Render would pull this instance`);
  }
  if (!body.includes('"status":"degraded"')) problems.push('body is missing status:"degraded"');
  if (!body.includes('"db":"down"')) problems.push('body is missing db:"down"');
  if (body.includes("ok")) {
    problems.push('body contains "ok" — the UptimeRobot keyword monitor would NOT alert on a real outage');
  }
  if (res.headers.get("cache-control") !== "no-store") {
    problems.push(`cache-control is "${res.headers.get("cache-control")}", expected no-store`);
  }

  console.log(`${url}\n  ${res.status} ${body}`);
  if (problems.length) {
    failures += problems.length;
    for (const p of problems) console.log(`  FAIL: ${p}`);
  } else {
    console.log("  PASS: 200 + degraded body + no \"ok\" keyword + no-store");
  }
}

console.log(failures ? `\n${failures} failure(s)` : "\nOPS-3 degraded-path contract holds.");
process.exit(failures ? 1 : 0);
