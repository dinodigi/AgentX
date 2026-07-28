#!/usr/bin/env node
/**
 * checkpoint — the fast pre-push gate.
 *
 * WHY THIS EXISTS: `npm run verify` runs 97 smoke files serially (~25 min).
 * A gate that expensive doesn't get run, so work piles up unpushed — which is
 * exactly the failure it was meant to prevent. This is the gate you can afford
 * to run every hour.
 *
 * It is NOT a replacement for `npm run verify`. It is the gate for a CHECKPOINT
 * push (one coherent batch). Run the full suite before ending a session.
 *
 * What it checks, in the order that fails cheapest-first:
 *   1. tsc --noEmit          (~30s)  — types
 *   2. next build            (~90s)  — CLAUDE.md hard rule: tsc alone misses
 *                                      Next route-file export rules, and master
 *                                      auto-deploys. This is the one that stops
 *                                      a broken deploy.
 *   3. the smoke files you name       — what you actually touched
 *
 * Usage:
 *   npm run checkpoint                     # types + build only (no server needed)
 *   npm run checkpoint -- 93 47            # ...plus smoke files matching 93*, 47*
 *   npm run checkpoint -- --no-build 93    # skip the build (dev server is running)
 *
 * NOTE: step 2 cannot run while a dev server is live — they share `.next` and
 * every request 500s until restart (CLAUDE.md). We detect a listening dev port
 * and refuse rather than corrupting it.
 */
import { spawnSync, execSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import net from "node:net";

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const patterns = args.filter((a) => !a.startsWith("--"));

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

function step(name, fn) {
  process.stdout.write(`\n\x1b[1m▸ ${name}\x1b[0m\n`);
  const ok = fn();
  if (!ok) {
    console.error(`\n\x1b[31m✗ CHECKPOINT FAILED at "${name}" (${el()})\x1b[0m`);
    console.error("  Do not push. Fix, then re-run.\n");
    process.exit(1);
  }
  console.log(`\x1b[32m  ✓ ${name}\x1b[0m (${el()})`);
}

const run = (cmd, cmdArgs) =>
  spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: true }).status === 0;

/** Is something listening on a port? A live dev server makes `next build` destructive. */
const portBusy = (port) =>
  new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
    setTimeout(() => (s.destroy(), resolve(false)), 400);
  });

// ---------------------------------------------------------------- 1. types
step("typecheck", () => run("npx", ["tsc", "--noEmit"]));

// ---------------------------------------------------------------- 2. build
if (!noBuild) {
  const busy = (await Promise.all([3000, 3100, 3200].map(portBusy))).some(Boolean);
  if (busy) {
    console.error(
      "\n\x1b[31m✗ a dev server is listening — `next build` would poison its .next\x1b[0m\n" +
        "  Stop it and re-run, or pass --no-build to skip (then you MUST build before pushing).\n",
    );
    process.exit(1);
  }
  // A `.next` left behind by a dev server makes the build worker die with
  // 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) — a crash, not a code error.
  // Reporting that as NO-GO teaches distrust of the gate, so we clear and retry
  // ONCE. A second failure is real and must be shown.
  step("next build", () => {
    if (run("npx", ["next", "build"])) return true;
    console.log("\n\x1b[33m  build worker died — clearing .next and retrying once\x1b[0m");
    rmSync(".next", { recursive: true, force: true });
    return run("npx", ["next", "build"]);
  });
} else {
  console.log("\n\x1b[33m▸ build SKIPPED (--no-build) — you must build before pushing master\x1b[0m");
}

// ---------------------------------------------------------------- 3. smokes
if (patterns.length) {
  const all = readdirSync("scripts/smoke").filter((f) => f.endsWith(".test.mjs"));
  const picked = all.filter((f) => patterns.some((p) => f.includes(p)));
  if (!picked.length) {
    console.error(`\n\x1b[31m✗ no smoke file matched: ${patterns.join(", ")}\x1b[0m`);
    process.exit(1);
  }
  console.log(`\n  matched ${picked.length}: ${picked.join(", ")}`);
  step("smoke (targeted)", () =>
    run("node", [
      "--env-file=.env",
      "--env-file=.env.test",
      "--test",
      "--test-concurrency=1",
      ...picked.map((f) => `scripts/smoke/${f}`),
    ]),
  );
} else {
  console.log("\n\x1b[33m▸ no smoke pattern given — types+build only\x1b[0m");
}

// ---------------------------------------------------------------- verdict
let dirty = "";
try {
  dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim();
} catch {}
const ahead = (() => {
  try {
    return execSync("git rev-list --count @{u}..HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
})();

console.log(`\n\x1b[32m\x1b[1m✓ CHECKPOINT GREEN\x1b[0m (${el()})`);
if (dirty) console.log(`  \x1b[33m${dirty.split("\n").length} file(s) uncommitted — commit them into this checkpoint\x1b[0m`);
console.log(`  ${ahead} commit(s) ahead of origin. Push:  git push\n`);
